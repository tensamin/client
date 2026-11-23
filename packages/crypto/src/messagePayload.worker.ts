import type { CodecRequest, CodecResponse } from "./messageCodec";
import { decodeMessagePayload, encodeMessagePayload } from "./messagePayload";

self.onmessage = async ({ data }: MessageEvent<CodecRequest>) => {
  try {
    const result =
      data.op === "encode"
        ? await encodeMessagePayload(data.input)
        : await decodeMessagePayload(data.input);

    self.postMessage({ id: data.id, result } satisfies CodecResponse);
  } catch (error) {
    const { name, message } =
      error instanceof Error ? error : new Error(String(error));

    self.postMessage({
      id: data.id,
      error: { name, message },
    } satisfies CodecResponse);
  }
};
