import {
  InvalidMessagePayloadError,
  MessageTooLargeError,
} from "./messagePayload";

const ENCODE_TIMEOUT_MS = 15_000;
const DECODE_TIMEOUT_MS = 2_000;

type Operation =
  { op: "encode"; input: string } | { op: "decode"; input: Uint8Array };

export type CodecRequest = Operation & { id: number };
export type CodecResponse = { id: number } & (
  { result: string | Uint8Array } | { error: { name: string; message: string } }
);

type Pending = {
  request: CodecRequest;
  timer?: ReturnType<typeof setTimeout>;
  resolve(result: string | Uint8Array): void;
  reject(error: unknown): void;
};

const pending = new Map<number, Pending>();
let worker: Worker | undefined;
let nextId = 0;

function takePending(id: number) {
  const entry = pending.get(id);

  if (!entry) return;

  clearTimeout(entry.timer);
  pending.delete(id);
  return entry;
}

function dispatch(entry: Pending) {
  const { id, op } = entry.request;

  try {
    const active = getWorker();
    active.postMessage(entry.request);
    entry.timer = setTimeout(
      () => {
        takePending(id)?.reject(
          new InvalidMessagePayloadError("Message decoding timed out"),
        );
        active.terminate();
        worker = undefined;

        // Terminating a stuck worker also drops its queued requests.
        for (const queued of pending.values()) {
          clearTimeout(queued.timer);
          dispatch(queued);
        }
      },
      op === "encode" ? ENCODE_TIMEOUT_MS : DECODE_TIMEOUT_MS,
    );
  } catch (error) {
    takePending(id)?.reject(error);
  }
}

function getWorker() {
  if (worker) return worker;

  const active = new Worker(
    new URL("./messagePayload.worker.ts", import.meta.url),
    {
      type: "module",
    },
  );
  active.onmessage = ({ data }: MessageEvent<CodecResponse>) => {
    if (worker !== active) return;

    const entry = takePending(data.id);
    if (!entry) return;

    if ("result" in data) {
      entry.resolve(data.result);
      return;
    }

    const { name, message } = data.error;
    if (name === "MessageTooLargeError")
      entry.reject(new MessageTooLargeError(message));
    else if (name === "InvalidMessagePayloadError")
      entry.reject(new InvalidMessagePayloadError(message));
    else entry.reject(new Error(message));
  };
  active.onerror = (event) => {
    event.preventDefault();
    if (worker !== active) return;

    active.terminate();
    worker = undefined;
    for (const id of pending.keys())
      takePending(id)?.reject(new Error("Message codec worker failed"));
  };

  worker = active;
  return active;
}

function run(
  request: Extract<Operation, { op: "encode" }>,
): Promise<Uint8Array>;
function run(request: Extract<Operation, { op: "decode" }>): Promise<string>;
function run(request: Operation): Promise<string | Uint8Array> {
  return new Promise((resolve, reject) => {
    const id = nextId++;
    const entry = { request: { id, ...request }, resolve, reject };

    pending.set(id, entry);
    dispatch(entry);
  });
}

export function encodeMessageText(text: string) {
  return run({ op: "encode", input: text });
}

export function decodeMessageText(payload: Uint8Array) {
  return run({ op: "decode", input: payload });
}
