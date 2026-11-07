import { beforeEach, expect, it, vi } from "vitest";
import {
  createNativeStage,
  loadNativeStage,
  nativeStageSource,
} from "./nativeStaging";

const bridge = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: bridge.invoke }));
const id = "13060dac-20db-4e5d-a57c-7e699ace9788";
beforeEach(() => {
  vi.resetAllMocks();
  let size = 0;
  bridge.invoke.mockImplementation(
    async (
      command: string,
      args: { bytes?: number[]; amount?: number; offset?: number },
    ) => {
      if (command === "file_stage_create")
        return { id, size: 0, committed: false };
      if (command === "file_stage_append") {
        size += args.bytes!.length;
        return size;
      }
      if (command === "file_stage_commit") return size;
      if (command === "file_stage_read")
        return [1, 2, 3, 4, 5].slice(args.offset, args.offset! + args.amount!);
      if (command === "file_stage_export") return true;
    },
  );
});

it("keeps native output unavailable until verification commits and preserves a cancelled save for another explicit attempt", async () => {
  const output = await createNativeStage(
    "account",
    new AbortController().signal,
    "plaintext",
  );
  await expect(output.save("file.bin")).rejects.toThrow("verification");
  await output.stage.write(Uint8Array.of(1, 2, 3));
  await output.stage.commit();
  await expect(output.file()).rejects.toThrow("ciphertext");
  bridge.invoke.mockResolvedValueOnce(false);
  expect(await output.save("file.bin")).toBe(false);
  expect(await output.save("file.bin")).toBe(true);
  expect(
    bridge.invoke.mock.calls.filter(
      ([command]) => command === "file_stage_export",
    ),
  ).toEqual([
    ["file_stage_export", { accountKey: "account", id, filename: "file.bin" }],
    ["file_stage_export", { accountKey: "account", id, filename: "file.bin" }],
  ]);
});

it("sends bounded sequential native chunks and rejects mismatched acknowledgements", async () => {
  const output = await createNativeStage(
    "account",
    new AbortController().signal,
    "ciphertext",
  );
  await expect(
    output.stage.write(new Uint8Array(256 * 1024 + 1)),
  ).rejects.toThrow("chunk budget");
  await output.stage.write(Uint8Array.of(1, 2));
  expect(bridge.invoke).toHaveBeenLastCalledWith("file_stage_append", {
    accountKey: "account",
    id,
    offset: 0,
    bytes: [1, 2],
  });
  bridge.invoke.mockResolvedValueOnce(99);
  await expect(output.stage.write(Uint8Array.of(3))).rejects.toThrow(
    "acknowledgement changed",
  );
  await output.stage.abort();
  await output.stage.abort();
  expect(
    bridge.invoke.mock.calls.filter(
      ([command]) => command === "file_stage_remove",
    ),
  ).toHaveLength(1);
});

it("reads only the requested committed native range instead of materializing the file", async () => {
  const source = nativeStageSource(
    "account",
    id,
    5,
    new AbortController().signal,
  );
  expect(new Uint8Array(await source.slice(1, 4).arrayBuffer())).toEqual(
    Uint8Array.of(2, 3, 4),
  );
  expect(bridge.invoke).toHaveBeenCalledExactlyOnceWith("file_stage_read", {
    accountKey: "account",
    id,
    offset: 1,
    amount: 3,
  });
  const large = nativeStageSource(
    "account",
    id,
    1024 * 1024,
    new AbortController().signal,
  );
  await expect(large.slice(0, 256 * 1024 + 1).arrayBuffer()).rejects.toThrow(
    "range budget",
  );
  bridge.invoke.mockResolvedValueOnce([1]);
  await expect(source.slice(0, 3).arrayBuffer()).rejects.toThrow("incomplete");
});

it("rejects incomplete recovered stages and stops input after account cancellation", async () => {
  bridge.invoke.mockResolvedValueOnce({ id, size: 3, committed: false });
  await expect(
    loadNativeStage("account", id, new AbortController().signal),
  ).rejects.toThrow("not committed");
  const controller = new AbortController();
  const stage = await createNativeStage(
    "account",
    controller.signal,
    "ciphertext",
  );
  controller.abort();
  const count = bridge.invoke.mock.calls.length;
  await expect(stage.stage.write(Uint8Array.of(1))).rejects.toThrow();
  expect(bridge.invoke).toHaveBeenCalledTimes(count);
});
