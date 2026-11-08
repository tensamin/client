import {
  base64ToBytes,
  bytesToBase64,
  MTPProtocolError,
  type MTPClient,
  type MTPRequestProtectedOptions,
  type MTPDataValueInput,
  type MTPProtectedTransport,
} from "mtp";
import { z } from "zod";
import {
  getDatabaseEntry,
  setDatabaseEntry,
  deleteDatabaseEntry,
} from "@tensamin/shared/indexedDb";
import {
  encodeSecureValue,
  decodeSecureValue,
  isSecureEnvelope,
} from "@tensamin/storage/secure";
import { CredentialVerificationError } from "../errors";
import { passwordRequestFailure, PasswordServiceError } from "./failure";

const pendingSchema = z.strictObject({
  binding: z.string(),
  version: z.string().regex(/^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/),
  command: z
    .base64()
    .min(4)
    .max(4 * Math.ceil((512 * 1024) / 3)),
  digest: z.base64().length(44),
  enabled: z.boolean(),
});
const receiptSchema = z.strictObject({
  Enabled: z.boolean(),
  Status: z.literal("committed"),
  Sha256: z
    .instanceof(Uint8Array<ArrayBufferLike>)
    .refine((bytes) => bytes.length === 32),
});

export function createPasswordMutations({
  client,
  binding,
  receiverId,
  rpc,
  signal,
}: {
  client: MTPProtectedTransport &
    Pick<
      MTPClient,
      | "requestProtected"
      | "requestRaw"
      | "preparedRequestDigest"
      | "dictionaryIdentity"
    >;
  binding: string;
  receiverId: bigint;
  rpc: Pick<MTPRequestProtectedOptions, "send" | "open">;
  signal?: AbortSignal;
}) {
  const key = `password-mutation:v1:${binding}`;
  async function read() {
    signal?.throwIfAborted();
    const stored = await getDatabaseEntry("cache", key);
    if (stored === undefined) return null;
    if (!isSecureEnvelope(stored))
      throw new CredentialVerificationError(
        "Pending password request is not protected",
      );
    const pending = pendingSchema.parse(await decodeSecureValue(stored));
    if (
      pending.binding !== binding ||
      base64ToBytes(pending.digest).length !== 32 ||
      base64ToBytes(pending.command).length > 512 * 1024
    )
      throw new CredentialVerificationError(
        "Pending password request belongs to another scope or is invalid",
      );
    signal?.throwIfAborted();
    return pending;
  }

  async function openResponse(
    request: () => ReturnType<MTPClient["requestRaw"]>,
  ) {
    let frame: Awaited<ReturnType<MTPClient["requestRaw"]>>;
    try {
      frame = await request();
    } catch (error) {
      if (!(error instanceof MTPProtocolError)) throw error;
      try {
        return await client.openProtected(error.frame, rpc.open);
      } catch {
        throw error;
      }
    }
    return client.openProtected(frame, rpc.open);
  }

  async function acceptVerified(
    opened: Awaited<ReturnType<typeof client.openProtected>>,
    pending: z.output<typeof pendingSchema>,
  ) {
    signal?.throwIfAborted();
    if (opened.type.startsWith("Error")) {
      const error = new MTPProtocolError({
        type: opened.type,
        data: opened.data,
      });
      const failure = passwordRequestFailure(error);
      const rejection = z
        .object({ Sha256: receiptSchema.shape.Sha256 })
        .safeParse(opened.data);
      if (
        failure instanceof PasswordServiceError &&
        failure.code === "expired" &&
        rejection.success
      ) {
        const digest = base64ToBytes(pending.digest);
        if (
          rejection.data.Sha256.every((byte, index) => byte === digest[index])
        )
          await deleteDatabaseEntry("cache", key);
      }
      throw error;
    }
    if (opened.type !== "PasswordEnrollmentStatus")
      throw new CredentialVerificationError(
        "Unexpected password mutation receipt",
      );
    const receipt = receiptSchema.parse(opened.data);
    const digest = base64ToBytes(pending.digest);
    if (
      receipt.Enabled !== pending.enabled ||
      !receipt.Sha256.every((byte, index) => byte === digest[index])
    )
      throw new CredentialVerificationError(
        "Password receipt does not match the original request",
      );
    await deleteDatabaseEntry("cache", key);
    signal?.throwIfAborted();
    return receipt.Enabled;
  }

  return {
    async withLock<T>(operation: () => Promise<T>): Promise<T> {
      signal?.throwIfAborted();
      if (!navigator.locks)
        throw new Error("Password request recovery requires Web Locks");
      return navigator.locks.request(key, { signal }, operation);
    },
    async reconcile(): Promise<boolean | null> {
      const pending = await read();
      if (!pending) return null;
      const response = await openResponse(() =>
        client.requestRaw(
          "PasswordEnrollmentStatus",
          {
            SecurePayload: base64ToBytes(pending.command),
            Version: pending.version,
          },
          { receiver: receiverId, responseType: "PasswordEnrollmentStatus" },
        ),
      );
      // This is a receipt query, never retransmission of an uncertain mutation.
      // An unknown outcome leaves the original intent intact and blocks changes.
      return acceptVerified(response, pending);
    },
    async mutate(
      type: "PasswordEnrollmentFinish" | "PasswordEnrollmentDisable",
      data: MTPDataValueInput,
    ): Promise<boolean> {
      if (await read()) throw new PasswordServiceError("unknown_outcome");
      const version = client.dictionaryIdentity?.version;
      if (!version)
        throw new Error("Password request dictionary identity is unavailable");
      let pending: z.output<typeof pendingSchema> | undefined;
      let released = false;
      let response: Awaited<ReturnType<typeof client.openProtected>>;
      try {
        response = await openResponse(() =>
          client.requestProtected(type, data, rpc.send, {
            responseType: "PasswordEnrollmentStatus",
            beforeSend: async (command) => {
              signal?.throwIfAborted();
              if (command.length > 512 * 1024)
                throw new Error("Password command exceeds the protocol limit");
              pending = pendingSchema.parse({
                binding,
                version,
                command: bytesToBase64(command),
                digest: bytesToBase64(client.preparedRequestDigest(command)),
                enabled: type === "PasswordEnrollmentFinish",
              });
              await setDatabaseEntry(
                "cache",
                key,
                await encodeSecureValue(pending),
              );
              signal?.throwIfAborted();
              released = true;
            },
          }),
        );
      } catch (error) {
        // The SDK guarantees that a rejected beforeSend callback sends nothing.
        // Once released, transport failure is uncertain and must retain the intent.
        if (pending && !released) await deleteDatabaseEntry("cache", key);
        throw error;
      }
      if (!pending) throw new Error("Password request was not made durable");
      return acceptVerified(response, pending);
    },
  };
}
