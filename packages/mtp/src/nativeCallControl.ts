import { invoke } from "@tauri-apps/api/core";
import { decode, encode, MTPProtocol, type MTPClient } from "mtp";
import { mtp as schemas } from "@tensamin/shared/data";
import type { BoundSendFn, MTPContextType } from "./mtpContext";

export const callControlRequests: ReadonlySet<string> = new Set([
  "CallReserve",
  "CallActivate",
  "CallToken",
  "CallData",
  "CallInvite",
  "CallDisconnectUser",
  "CallTimeoutUser",
  "CallSetAnonymousJoining",
  "EndCall",
]);

export function createNativeCallControl({
  send,
  session,
}: {
  send: (...args: Parameters<BoundSendFn>) => ReturnType<BoundSendFn>;
  session: () => {
    authenticated: boolean;
    generation: number;
    client: Pick<MTPClient<typeof schemas>, "dictionaryIdentity"> | null;
  };
}): MTPContextType["sendCallControl"] {
  const protocol = new MTPProtocol({ schemas, throwProtocolErrors: true });

  return async (ownerOmikronId, type, data, options) => {
    if (!callControlRequests.has(type))
      throw new Error("Call control requires a call request");

    if (ownerOmikronId === undefined) return send(type, data, options);

    if (!Number.isSafeInteger(ownerOmikronId) || ownerOmikronId <= 0)
      throw new Error("Call owner must be a positive safe integer");
    const active = { ...session() };
    const dictionary = active.client?.dictionaryIdentity?.fingerprint;

    if (!active.authenticated || !active.client || !dictionary)
      throw new Error("Native call control is not authenticated");
    const assertCurrent = () => {
      const current = session();

      if (
        !current.authenticated ||
        current.generation !== active.generation ||
        current.client !== active.client
      )
        throw new Error("Native session changed during call control");
    };

    const timeoutMs = options?.timeoutMs ?? 30_000;

    if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0)
      throw new Error("Call request timeout must be a positive safe integer");
    const parsed = await protocol.parseRequest(type, data);
    const frame = encode(type, parsed ?? {}, options);
    await options?.beforeSend?.(new Uint8Array(frame));
    assertCurrent();
    const bytes = await invoke<number[]>("mtp_send_call_control", {
      ownerOmikronId,
      generation: active.generation,
      dictionaryFingerprint: dictionary,
      frame: Array.from(frame),
      timeoutMs,
      responseType: options?.responseType,
    });
    assertCurrent();
    const response = await protocol.parseResponse(
      type,
      decode(Uint8Array.from(bytes)),
    );
    assertCurrent();

    return response;
  };
}
