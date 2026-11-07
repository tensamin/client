import { beforeEach, afterEach, expect, it, vi } from "vitest";
import { createFileOutput } from "./output";

const io = vi.hoisted(() => ({
  files: new Map<string, { chunks: Uint8Array<ArrayBuffer>[] }>(),
  locks: new Set<string>(),
  writes: 0,
}));
vi.mock("@tauri-apps/api/core", () => ({
  isTauri: () => false,
  invoke: vi.fn(),
}));
vi.mock("./staging", () => ({
  accountDirectory: async () => ({
    async *entries() {
      for (const name of [...io.files.keys()]) yield [name, { kind: "file" }];
    },
    async removeEntry(name: string) {
      if (!io.files.delete(name))
        throw new DOMException("missing", "NotFoundError");
    },
    async getFileHandle(name: string) {
      const contents = { chunks: [] as Uint8Array<ArrayBuffer>[] };
      io.files.set(name, contents);
      return {
        async createWritable() {
          return {
            async write(bytes: Uint8Array) {
              io.writes++;
              contents.chunks.push(new Uint8Array(bytes));
            },
            async close() {},
            async abort() {
              contents.chunks = [];
            },
          };
        },
        async getFile() {
          return new File(contents.chunks, name);
        },
      };
    },
  }),
}));

beforeEach(() => {
  io.files.clear();
  io.locks.clear();
  io.writes = 0;
  vi.stubGlobal("navigator", {
    locks: {
      request: async (
        name: string,
        options: { ifAvailable?: boolean; signal?: AbortSignal },
        run: (lock: unknown) => Promise<unknown>,
      ) => {
        options.signal?.throwIfAborted();
        if (io.locks.has(name)) {
          if (options.ifAvailable) return run(null);
          throw new Error("unexpected lock collision");
        }
        io.locks.add(name);
        try {
          return await run({ name });
        } finally {
          io.locks.delete(name);
        }
      },
    },
  });
});
afterEach(() => vi.unstubAllGlobals());

it("keeps browser plaintext private until verification commits and discards its owned output explicitly", async () => {
  const output = await createFileOutput(
    "account",
    new AbortController().signal,
  );
  if (output.kind !== "browser") throw new Error("browser output expected");
  await output.stage.write(new TextEncoder().encode("private contents"));
  await expect(output.file()).rejects.toThrow("verification");
  await output.stage.commit();
  expect(await (await output.file()).text()).toBe("private contents");
  expect(io.locks.size).toBe(1);
  await output.abort();
  expect(io.files.size).toBe(0);
  expect(io.locks.size).toBe(0);
});

it("reclaims only orphan output rather than deleting another active tab's stage", async () => {
  const orphan = "7891d95e-c814-4e64-9ddc-835c728697de";
  io.files.set(orphan, { chunks: [] });
  const first = await createFileOutput("account", new AbortController().signal);
  expect(io.files.has(orphan)).toBe(false);
  const activeName = [...io.files.keys()][0];
  const second = await createFileOutput(
    "account",
    new AbortController().signal,
  );
  expect(io.files.has(activeName)).toBe(true);
  expect(io.files.size).toBe(2);
  await second.abort();
  expect(io.files.has(activeName)).toBe(true);
  await first.abort();
});

it("releases aborted ownership, refuses further writes and tolerates subsequent orphan cleanup", async () => {
  const controller = new AbortController();
  const output = await createFileOutput("account", controller.signal);
  controller.abort();
  await Promise.resolve();
  await expect(output.stage.write(Uint8Array.of(1))).rejects.toThrow();
  expect(io.writes).toBe(0);
  const replacement = await createFileOutput(
    "account",
    new AbortController().signal,
  );
  expect(io.files.size).toBe(1);
  await output.abort();
  await replacement.abort();
  expect(io.files.size).toBe(0);
});
