import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  createConversationNotifications,
  type IncomingNotification,
} from "./conversations";

const message = (principal: string, time = 1): IncomingNotification => ({
  principal,
  relayId: String(time),
  time,
  kind: "message",
});
const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });

  return { promise, resolve };
};

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

it("does not replace a completed notification with an older delayed delivery", async () => {
  const shown: number[] = [];
  const queue = createConversationNotifications(
    async (incoming) => {
      shown.push(incoming.time);
    },
    (error) => {
      throw error;
    },
  );
  queue.enqueue(message("chat", 2));
  await vi.advanceTimersByTimeAsync(200);
  queue.enqueue(message("chat", 1));
  await vi.advanceTimersByTimeAsync(200);
  expect(shown).toEqual([2]);
  queue.close();
});

it("debounces a conversation without blocking another conversation's preparation", async () => {
  const key = deferred();
  const shown: string[] = [];
  const queue = createConversationNotifications(
    async (incoming, current) => {
      if (incoming.principal === "slow") await key.promise;

      if (current()) shown.push(incoming.principal);
    },
    (error) => {
      throw error;
    },
  );
  queue.enqueue(message("slow"));
  queue.enqueue(message("fast"));
  await vi.advanceTimersByTimeAsync(199);
  expect(shown).toEqual([]);
  await vi.advanceTimersByTimeAsync(1);
  expect(shown).toEqual(["fast"]);
  key.resolve();
  await vi.advanceTimersByTimeAsync(0);
  expect(shown).toEqual(["fast", "slow"]);
  queue.close();
});

it("uses the newest message and invalidates an older asynchronous result", async () => {
  const key = deferred();
  const prepared: number[] = [],
    shown: number[] = [];
  const queue = createConversationNotifications(
    async (incoming, current) => {
      prepared.push(incoming.time);

      if (incoming.time === 1) await key.promise;

      if (current()) shown.push(incoming.time);
    },
    (error) => {
      throw error;
    },
  );
  queue.enqueue(message("chat", 1));
  await vi.advanceTimersByTimeAsync(200);
  queue.enqueue(message("chat", 2));
  queue.enqueue(message("chat", 3));
  await vi.advanceTimersByTimeAsync(200);
  expect(prepared).toEqual([1]);
  key.resolve();
  await vi.advanceTimersByTimeAsync(0);
  expect(prepared).toEqual([1, 3]);
  expect(shown).toEqual([3]);
  queue.close();
});

it("caps debounce wait at one second under a continuous burst", async () => {
  const shown: number[] = [];
  const queue = createConversationNotifications(
    async (incoming) => {
      shown.push(incoming.time);
    },
    (error) => {
      throw error;
    },
  );

  for (let time = 0; time < 10; time++) {
    queue.enqueue(message("chat", time));
    await vi.advanceTimersByTimeAsync(100);
  }

  expect(shown).toEqual([9]);
  queue.close();
});

it("suppresses duplicates and limits independent requests to four", async () => {
  const gate = deferred();
  let started = 0;
  const queue = createConversationNotifications(
    async () => {
      started++;
      await gate.promise;
    },
    (error) => {
      throw error;
    },
  );

  for (let index = 0; index < 8; index++) {
    queue.enqueue(message(String(index)));
    queue.enqueue(message(String(index)));
  }

  await vi.advanceTimersByTimeAsync(200);
  expect(started).toBe(4);
  gate.resolve();
  await vi.advanceTimersByTimeAsync(0);
  expect(started).toBe(8);
  queue.close();
});

it("releases capacity after failed preparation and cancels stale account work", async () => {
  const gate = deferred();
  const shown: string[] = [],
    failures: unknown[] = [];
  const queue = createConversationNotifications(
    async (incoming, current) => {
      if (incoming.principal === "failed") throw new Error("lookup failed");
      await gate.promise;

      if (current()) shown.push(incoming.principal);
    },
    (error) => {
      failures.push(error);
    },
  );
  queue.enqueue(message("failed"));
  queue.enqueue(message("old-account"));
  await vi.advanceTimersByTimeAsync(200);
  expect(failures).toHaveLength(1);
  queue.close();
  gate.resolve();
  await vi.advanceTimersByTimeAsync(1000);
  expect(shown).toEqual([]);
});
