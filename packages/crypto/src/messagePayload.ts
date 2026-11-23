// Payload layout inside the AEAD ciphertext: flag byte, LEB128 original byte length, data.
export const MAX_MESSAGE_TEXT_BYTES = 256 * 1024;

const RAW = 0;
const BROTLI = 1;
const MAX_LENGTH_BYTES = 3;
const DECOMPRESS_CHUNK_BYTES = 16 * 1024;

// Above this input size quality 11 gets slow, so it only runs when quality 9 is already close to fitting.
const LARGE_INPUT_BYTES = 64 * 1024;
const LARGE_INPUT_Q11_MAX_OUTPUT = 40 * 1024;

let brotliModule: typeof import("brotli-wasm").default | undefined;

function loadBrotli() {
  return (brotliModule ??= import("brotli-wasm").then(
    ({ default: brotli }) => brotli,
  ));
}

const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

export class InvalidMessagePayloadError extends Error {
  name = "InvalidMessagePayloadError";
}

export class MessageTooLargeError extends Error {
  name = "MessageTooLargeError";
}

export async function encodeMessagePayload(text: string): Promise<Uint8Array> {
  const bytes = encoder.encode(text);

  if (bytes.length > MAX_MESSAGE_TEXT_BYTES) {
    throw new MessageTooLargeError(
      `Messages can be at most ${MAX_MESSAGE_TEXT_BYTES / 1024} KiB of text.`,
    );
  }

  let data: Uint8Array = bytes;

  if (bytes.length > 0) {
    const brotli = await loadBrotli();
    const tryQuality = (quality: number) => {
      const compressed = brotli.compress(bytes, { quality });

      if (compressed.length < data.length) data = compressed;
    };

    tryQuality(9);
    if (
      bytes.length <= LARGE_INPUT_BYTES ||
      data.length <= LARGE_INPUT_Q11_MAX_OUTPUT
    ) {
      tryQuality(11);
    }
  }

  const length = writeLength(bytes.length);
  const payload = new Uint8Array(1 + length.length + data.length);

  payload[0] = data === bytes ? RAW : BROTLI;
  payload.set(length, 1);
  payload.set(data, 1 + length.length);

  return payload;
}

export async function decodeMessagePayload(
  payload: Uint8Array,
): Promise<string> {
  const flag = payload[0];

  if (flag !== RAW && flag !== BROTLI) {
    throw new InvalidMessagePayloadError("Unknown message compression flag");
  }

  const [length, lengthBytes] = readLength(payload);

  if (length > MAX_MESSAGE_TEXT_BYTES) {
    throw new InvalidMessagePayloadError("Declared message length too large");
  }

  const data = payload.subarray(1 + lengthBytes);
  const bytes = flag === RAW ? data : await decompressExactly(data, length);

  if (bytes.length !== length) {
    throw new InvalidMessagePayloadError("Message length mismatch");
  }

  try {
    return decoder.decode(bytes);
  } catch {
    throw new InvalidMessagePayloadError("Message is not valid UTF-8");
  }
}

async function decompressExactly(
  data: Uint8Array,
  length: number,
): Promise<Uint8Array> {
  if (data.length === 0) {
    throw new InvalidMessagePayloadError("Empty compressed message");
  }

  const brotli = await loadBrotli();
  const { NeedsMoreInput, NeedsMoreOutput, ResultSuccess } =
    brotli.BrotliStreamResultCode;
  const stream = new brotli.DecompressStream();
  const output = new Uint8Array(length);
  let written = 0;
  let consumed = 0;

  try {
    while (true) {
      // Ask for one byte past the declared length so overflow is detected.
      const result = stream.decompress(
        data.subarray(consumed),
        Math.min(DECOMPRESS_CHUNK_BYTES, length - written + 1),
      );
      const { buf, code, input_offset } = result;

      result.free();
      if (written + buf.length > length) {
        throw new InvalidMessagePayloadError("Message exceeds declared length");
      }
      output.set(buf, written);
      written += buf.length;
      consumed += input_offset;

      if (code === ResultSuccess) {
        if (consumed !== data.length) {
          throw new InvalidMessagePayloadError("Trailing compressed data");
        }

        return output.subarray(0, written);
      }

      if (code === NeedsMoreInput && consumed >= data.length) {
        throw new InvalidMessagePayloadError("Truncated compressed message");
      }

      if (
        (code !== NeedsMoreInput && code !== NeedsMoreOutput) ||
        (input_offset === 0 && buf.length === 0)
      ) {
        throw new InvalidMessagePayloadError("Malformed compressed message");
      }
    }
  } catch (error) {
    if (error instanceof InvalidMessagePayloadError) throw error;
    throw new InvalidMessagePayloadError("Malformed compressed message");
  } finally {
    stream.free();
  }
}

function writeLength(value: number): Uint8Array {
  const bytes: number[] = [];

  do {
    let byte = value & 0x7f;

    value >>>= 7;
    if (value > 0) byte |= 0x80;
    bytes.push(byte);
  } while (value > 0);

  return Uint8Array.from(bytes);
}

function readLength(payload: Uint8Array): [number, number] {
  let value = 0;

  for (let index = 0; index < MAX_LENGTH_BYTES; index++) {
    const byte = payload[1 + index];

    if (byte === undefined) break;
    value |= (byte & 0x7f) << (7 * index);
    if ((byte & 0x80) === 0) {
      if (byte === 0 && index > 0) {
        throw new InvalidMessagePayloadError("Non-minimal message length");
      }

      return [value, index + 1];
    }
  }

  throw new InvalidMessagePayloadError("Malformed message length");
}
