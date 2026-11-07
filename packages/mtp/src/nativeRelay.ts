import { invoke } from "@tauri-apps/api/core";
import { decode, type MTPClient } from "mtp";
import type { RelayOutboxClient } from "./relayOutbox";

export function createNativeRelayClient({
  session,
}: {
  session: () => {
    authenticated: boolean;
    generation: number;
    client: MTPClient | null;
  };
}): RelayOutboxClient {
  function capture() {
    const active = { ...session() };
    const dictionary = active.client?.dictionaryIdentity?.fingerprint;
    if (!active.authenticated || !active.client || !dictionary)
      throw new Error("Native relay session is not authenticated");
    const assertCurrent = () => {
      const current = session();
      if (
        !current.authenticated ||
        current.generation !== active.generation ||
        current.client !== active.client
      )
        throw new Error("Native session changed during outgoing relay");
    };
    return { ...active, dictionary, assertCurrent };
  }
  const requestPrepared: RelayOutboxClient["requestPrepared"] = async (
    frame,
    request,
  ) => {
    const active = capture();
    await request.beforeSend(frame.slice());
    active.assertCurrent();
    const response = await invoke<number[]>("mtp_send_prepared_relay", {
      frame: Array.from(frame),
      generation: active.generation,
      dictionaryFingerprint: active.dictionary,
    });
    active.assertCurrent();
    return decode(Uint8Array.from(response));
  };
  return {
    get dictionaryIdentity() {
      return session().client?.dictionaryIdentity ?? null;
    },
    requestPrepared,
    async requestSealedRelay(type, data, options, request) {
      const active = capture();
      const frame = await invoke<number[]>("mtp_prepare_sealed_relay", {
        generation: active.generation,
        dictionaryFingerprint: active.dictionary,
        request: {
          typeName: type,
          data: JSON.parse(
            JSON.stringify(data, (_key, value) =>
              value instanceof Uint8Array ? Array.from(value) : value,
            ),
          ),
          nextHop: options.nextHop,
          finalRecipientId: options.finalRecipientId,
          metadataRecipients: options.metadataRecipients,
          contentRecipients: options.contentRecipients,
          metadata:
            options.metadata instanceof Uint8Array
              ? Array.from(options.metadata)
              : options.metadata,
        },
      });
      active.assertCurrent();
      return requestPrepared(Uint8Array.from(frame), request);
    },
  };
}
