import { MTPProtocolError } from "mtp";
import { z } from "zod";
import { mtp } from "@tensamin/shared/data";
import {
  deriveChatId,
  encodePrincipal,
  type Principal,
} from "@tensamin/shared/principal";
import {
  CHAT_SECRET_WRAPPING_SCHEME,
  deriveChatSecretId,
  randomChatSecret,
  unwrapChatSecret,
  wrapChatSecret,
} from "@tensamin/crypto/chatSecret";

const unavailable = z.strictObject({
  state: z.enum([
    "no_such_conversation",
    "pending",
    "epoch_unavailable",
    "accepted_but_envelope_unavailable",
    "unauthorized",
    "conflict",
    "retryable_dependency",
  ]),
  retryable: z.boolean(),
});

export type SecretState =
  | { kind: "ready"; value: Uint8Array; version: number }
  | { kind: "pending" | "recovering" | "uninitialized" }
  | { kind: "retryable" | "terminal"; reason: string };

export function decodeSecretRead(
  response: { type: string; data: unknown },
  request: {
    UserId: string;
    ChatId: string;
    SecretId: string;
    VersionNumber?: number;
  },
) {
  if (response.type === "ChatSecretResponse") {
    const data = mtp.ChatSecretResponse.response.parse(response.data);
    if (
      data.UserId !== request.UserId ||
      data.ChatId !== request.ChatId ||
      data.SecretId !== request.SecretId ||
      (request.VersionNumber !== undefined &&
        data.VersionNumber !== request.VersionNumber) ||
      data.WrappingScheme !== CHAT_SECRET_WRAPPING_SCHEME ||
      data.EncryptedSecret.length === 0 ||
      data.KemCiphertext.length === 0 ||
      !Number.isSafeInteger(data.CreatedAt) ||
      data.CreatedAt < 0 ||
      !Number.isSafeInteger(data.UpdatedAt) ||
      data.UpdatedAt < data.CreatedAt
    ) {
      throw new Error(
        "Chat secret envelope does not match the requested scope",
      );
    }
    return { kind: "envelope" as const, data };
  }
  const fields = z
    .strictObject({ ErrorType: z.string(), Json: z.instanceof(Uint8Array) })
    .parse(response.data);
  if (fields.Json.length > 256)
    throw new Error("Chat secret outcome exceeds capacity");
  const outcome = unavailable.parse(
    JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(fields.Json)),
  );
  const expectedType = {
    no_such_conversation: "ErrorNotSet",
    epoch_unavailable: "ErrorNotSet",
    pending: "ErrorInvalidData",
    conflict: "ErrorInvalidData",
    unauthorized: "ErrorNotAuthenticated",
    accepted_but_envelope_unavailable: "ErrorInternal",
    retryable_dependency: "ErrorInternal",
  }[outcome.state];
  const retryable = [
    "pending",
    "accepted_but_envelope_unavailable",
    "retryable_dependency",
  ].includes(outcome.state);
  if (
    response.type !== expectedType ||
    fields.ErrorType !== outcome.state ||
    outcome.retryable !== retryable
  ) {
    throw new Error("Invalid chat secret outcome");
  }
  return { kind: "unavailable" as const, ...outcome };
}

export class ConversationSecrets {
  private readonly flights = new Map<string, Promise<SecretState>>();
  private readonly epochs = new Map<
    string,
    Extract<SecretState, { kind: "ready" }>
  >();
  private active = true;

  private readonly options: {
    owner: Principal;
    keyring: () => Promise<string>;
    request: (data: {
      UserId: string;
      ChatId: string;
      SecretId: string;
      VersionNumber?: number;
    }) => Promise<{ type: string; data: unknown }>;
    propose: (
      peer: Principal,
      data: z.infer<typeof mtp.SetChatSecret.request>,
    ) => Promise<{ type: string; data: Record<string, unknown> }>;
    kemKeys: (peer: Principal) => Promise<[Uint8Array, Uint8Array]>;
  };

  constructor(options: ConversationSecrets["options"]) {
    this.options = options;
  }

  async read(peer: Principal, version?: number): Promise<SecretState> {
    if (!this.active) throw new Error("Chat secret account was closed");
    if (
      version !== undefined &&
      (!Number.isSafeInteger(version) || version <= 0)
    )
      throw new Error("Invalid secret epoch");
    const chatId = deriveChatId(this.options.owner, peer);
    const key = `${chatId}:${version ?? "latest"}`;
    if (version !== undefined) {
      const cached = this.epochs.get(key);
      if (cached) return cached;
    }
    const request = {
      UserId: encodePrincipal(this.options.owner),
      ChatId: chatId,
      SecretId: deriveChatSecretId(chatId),
      ...(version !== undefined && { VersionNumber: version }),
    };
    let response;
    try {
      response = await this.options.request(request);
    } catch (error) {
      if (!(error instanceof MTPProtocolError)) throw error;
      response = error.frame;
    }
    const result = decodeSecretRead(response, request);
    if (result.kind === "unavailable") {
      switch (result.state) {
        case "no_such_conversation":
          return version === undefined
            ? { kind: "uninitialized" }
            : { kind: "terminal", reason: "epoch_unavailable" };
        case "pending":
          return { kind: "pending" };
        case "accepted_but_envelope_unavailable":
          return { kind: "recovering" };
        case "retryable_dependency":
          return { kind: "retryable", reason: result.state };
        default:
          return { kind: "terminal", reason: result.state };
      }
    }
    const data = result.data;
    const value = await unwrapChatSecret({
      encryptedSecret: data.EncryptedSecret,
      kemCiphertext: data.KemCiphertext,
      keyring: await this.options.keyring(),
      chatId,
      secretId: request.SecretId,
      version: data.VersionNumber,
      wrappingScheme: data.WrappingScheme,
    });
    if (!this.active || value.length !== 32) {
      value.fill(0);
      throw new Error("Chat secret account or key is invalid");
    }
    const ready = {
      kind: "ready" as const,
      value,
      version: data.VersionNumber,
    };
    const epochKey = `${chatId}:${data.VersionNumber}`;
    const existing = this.epochs.get(epochKey);
    if (existing) {
      const equal = existing.value.every((byte, i) => byte === value[i]);
      value.fill(0);
      if (!equal) throw new Error("Committed chat secret epoch changed");
      return existing;
    }
    this.epochs.set(epochKey, ready);
    return ready;
  }

  ensure(peer: Principal): Promise<SecretState> {
    const chatId = deriveChatId(this.options.owner, peer);
    const existing = this.flights.get(chatId);
    if (existing) return existing;
    const flight = this.initialize(peer, chatId);
    this.flights.set(chatId, flight);
    const clear = () => {
      if (this.flights.get(chatId) === flight) this.flights.delete(chatId);
    };
    void flight.then(clear, clear);
    return flight;
  }

  private async initialize(
    peer: Principal,
    chatId: string,
  ): Promise<SecretState> {
    const current = await this.read(peer);
    if (current.kind !== "uninitialized") return current;
    const keys = await this.options.kemKeys(peer);
    if (!this.active) throw new Error("Chat secret account was closed");
    const raw = randomChatSecret();
    let publication:
      { type: string; data: Record<string, unknown> } | undefined;
    let failure: unknown;
    try {
      const wrapped = await Promise.all(
        keys.map((recipientKemPublicKey) =>
          wrapChatSecret({
            chatSecret: raw,
            recipientKemPublicKey,
            chatId,
            secretId: deriveChatSecretId(chatId),
            version: 1,
          }),
        ),
      );
      if (!this.active) throw new Error("Chat secret account was closed");
      publication = await this.options.propose(peer, {
        ChatId: chatId,
        SecretId: deriveChatSecretId(chatId),
        VersionNumber: 1,
        WrappingScheme: CHAT_SECRET_WRAPPING_SCHEME,
        Recipients: wrapped.map((copy, i) => ({
          UserId: encodePrincipal(i === 0 ? this.options.owner : peer),
          EncryptedSecret: new Uint8Array(copy.encryptedSecret),
          KemCiphertext: new Uint8Array(copy.kemCiphertext),
        })),
      });
    } catch (error) {
      failure = error;
    } finally {
      raw.fill(0);
    }
    // The read, not a relay receipt or the local proposal, selects the usable key.
    const winner = await this.read(peer);
    if (winner.kind !== "uninitialized") return winner;
    if (failure) throw failure;
    if (publication?.type === "Success") return { kind: "pending" };
    return {
      kind:
        publication?.type === "ErrorNotAuthenticated" ||
        publication?.type === "ErrorInvalidData"
          ? "terminal"
          : "retryable",
      reason: publication?.type ?? "proposal_unconfirmed",
    };
  }

  close() {
    this.active = false;
    for (const secret of this.epochs.values()) secret.value.fill(0);
    this.epochs.clear();
    this.flights.clear();
  }
}
