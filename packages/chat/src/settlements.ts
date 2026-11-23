import { useCallback, useEffect, useRef } from "react";
import { fileKeySchema, type FileKey } from "@tensamin/crypto/file";
import { useFiles } from "@tensamin/files/context";
import { nextGrantRevision } from "@tensamin/files/service";
import { useSession } from "@tensamin/identity/session";
import { requireRelaySuccess, useMTP } from "@tensamin/mtp";
import { isDefinitiveRelayRejection } from "@tensamin/mtp/relayResult";
import type { Storage } from "@tensamin/shared/data";
import { parseExactJson, stringifyExactJson } from "@tensamin/shared/exactJson";
import { parsePrincipal } from "@tensamin/shared/principal";
import { useStorage } from "@tensamin/storage/context";
import { decryptChatMessage, getMessage, useChat } from "./context";
import { withChatFileStatuses, type ChatFile } from "./components/fileMessages";

type Settlement = Storage["pending_file_settlements"][number];

const UNCONFIRMED_LIFETIME = 86_400_000;

const settlementId = (
  entry: Pick<Settlement, "account" | "userId" | "sendTime">,
) => JSON.stringify([entry.account, entry.userId, entry.sendTime]);
const parseKey = (key: string) => fileKeySchema.parse(parseExactJson(key));
const fileId = (content: string) => {
  try {
    return (JSON.parse(content) as { file_id?: unknown }).file_id;
  } catch {
    return undefined;
  }
};

function targetStatus(file: Settlement["files"][number]): ChatFile["Status"] {
  if (file.state === "ready") return file.shared ? undefined : "uploading";
  return file.state;
}

function settlementShares(entry: Settlement) {
  return [
    ...entry.files.flatMap((file) =>
      file.offered
        ? [
            {
              recipient: entry.recipient,
              key: parseKey(file.key),
              revision: BigInt(file.offered) + 1n,
            },
          ]
        : [],
    ),
    ...entry.removed.map((key) => ({
      recipient: entry.recipient,
      key: parseKey(key),
    })),
  ];
}

export function useFileSettlements() {
  const { load, save } = useStorage();
  const { send } = useMTP();
  const { uploads, service, revoke } = useFiles();
  const {
    accountKey,
    userId,
    ownPrincipal,
    sendChatRelay,
    getChatSecret,
    beginFilesSettle,
  } = useChat();
  const { contacts } = useSession();
  const recipient = contacts.find(
    (contact) => contact.UserId === userId,
  )?.Principal;
  const uploadsRef = useRef(uploads);
  useEffect(() => {
    uploadsRef.current = uploads;
  }, [uploads]);

  const change = useCallback(
    (update: (all: Settlement[]) => Settlement[]) =>
      navigator.locks.request("pending_file_settlements", async () =>
        save(
          "pending_file_settlements",
          update(await load("pending_file_settlements")),
        ),
      ),
    [load, save],
  );
  const read = useCallback(
    async (id: string) =>
      (await load("pending_file_settlements")).find(
        (entry) => settlementId(entry) === id,
      ),
    [load],
  );
  const patch = useCallback(
    (id: string, update: (entry: Settlement) => Settlement) =>
      change((all) =>
        all.map((entry) =>
          settlementId(entry) === id ? update(entry) : entry,
        ),
      ),
    [change],
  );
  const remove = useCallback(
    async (id: string) => {
      let removed: Settlement | undefined;
      await change((all) =>
        all.filter((entry) => {
          if (settlementId(entry) !== id) return true;
          removed = entry;
          return false;
        }),
      );
      return removed;
    },
    [change],
  );

  const confirmed = useCallback(
    async (entry: Settlement) => {
      const message = await getMessage({
        sendTime: entry.sendTime,
        chatPartnerId: entry.userId,
        send,
      }).catch(() => undefined);
      if (!message || message.Principal !== ownPrincipal) return;
      if (message.Files.length !== entry.offset + entry.files.length) return;
      const secret = await getChatSecret(entry.userId, message.VersionNumber);
      if (!secret) return;
      const { Files } = await decryptChatMessage(secret, {
        ...message,
        Content: undefined,
      });
      const ids = Files.map((file) => fileId(file.Content));
      const removed = new Set(
        entry.removed.map((key) => parseKey(key).file_id),
      );
      const matches =
        entry.files.every(
          (file, index) =>
            ids[entry.offset + index] === parseKey(file.key).file_id,
        ) && !ids.some((id) => typeof id === "string" && removed.has(id));
      return matches ? message : undefined;
    },
    [send, ownPrincipal, getChatSecret],
  );

  const advance = useCallback(
    async (
      id: string,
      onStatuses?: (statuses: ChatFile["Status"][]) => void,
    ): Promise<"done" | "pending" | "unconfirmed" | "rejected" | "gone"> => {
      let entry = await read(id);
      if (!entry) return "gone";
      if (!service) return "pending";
      const message = await confirmed(entry);
      if (!message) return "unconfirmed";
      const peer = parsePrincipal(entry.recipient);
      const target = { ...peer, user_id: BigInt(peer.user_id) };
      if (entry.removed.length > 0) {
        const removed = entry.removed;
        await revoke(
          removed.map((key) => ({
            recipient: entry!.recipient,
            key: parseKey(key),
          })),
        ).catch(() => undefined);
        await patch(id, (current) => ({ ...current, removed: [] }));
      }
      for (const [index, file] of entry.files.entries()) {
        if (file.state !== "ready" || file.shared) continue;
        const key = parseKey(file.key);
        const offered = file.offered
          ? BigInt(file.offered)
          : await nextGrantRevision(service, key, target);
        const setFile = (update: Partial<Settlement["files"][number]>) =>
          patch(id, (current) => ({
            ...current,
            files: current.files.map((item, at) =>
              at === index ? { ...item, ...update } : item,
            ),
          }));

        await setFile({ offered: String(offered) });
        try {
          await service.share({
            key,
            recipient: target,
            expiresAt: BigInt(file.expiresAt),
            grantRevision: offered,
          });
          await setFile({ shared: true });
          if (!(await read(id)))
            await revoke([
              { recipient: entry.recipient, key, revision: offered + 1n },
            ]).catch(() => undefined);
        } catch {
          await setFile({ state: "failed" });
          await revoke([
            { recipient: entry.recipient, key, revision: offered + 1n },
          ]).catch(() => undefined);
        }
      }
      for (let attempt = 0; attempt < 2; attempt++) {
        entry = await read(id);
        if (!entry) return "gone";
        const current = attempt === 0 ? message : await confirmed(entry);
        if (!current) return "unconfirmed";
        const statuses = entry.files.map(targetStatus);
        const held = current.Files.slice(entry.offset).map(
          (file) => file.Status,
        );
        if (statuses.every((status, index) => status === held[index])) {
          onStatuses?.(statuses);
          return statuses.includes("uploading") ? "pending" : "done";
        }
        try {
          requireRelaySuccess(
            await sendChatRelay(entry.userId, "MessageFilesUpdate", {
              Files: withChatFileStatuses(
                current.Files,
                entry.offset,
                statuses,
              ),
              SendTime: entry.sendTime,
            }),
          );
        } catch (error) {
          if (isDefinitiveRelayRejection(error)) return "rejected";
        }
      }
      return "pending";
    },
    [read, service, confirmed, revoke, patch, sendChatRelay],
  );

  const run = useCallback(
    async (
      id: string,
      sendTime: number,
      onStatuses?: (statuses: ChatFile["Status"][]) => void,
    ) => {
      const entry = await read(id);
      if (!entry) return;
      const finish = beginFilesSettle(sendTime);
      try {
        let queue =
          Promise.resolve<Awaited<ReturnType<typeof advance>>>("pending");

        await Promise.all(
          entry.files.map(async (file, index) => {
            if (file.state === "uploading") {
              const upload = uploadsRef.current[file.key];
              const state = upload ? await upload.result : "failed";
              await patch(id, (current) => ({
                ...current,
                files: current.files.map((item, at) =>
                  at === index ? { ...item, state } : item,
                ),
              }));
            }

            queue = queue.then((previous) =>
              previous === "rejected" ? previous : advance(id, onStatuses),
            );
            await queue;
          }),
        );
        const result = entry.files.length
          ? await queue
          : await advance(id, onStatuses);
        if (result === "done") await remove(id);
        else if (result === "rejected") {
          const removed = await remove(id);
          if (removed)
            await revoke(settlementShares(removed)).catch(() => undefined);
        } else if (
          result === "unconfirmed" &&
          Date.now() - entry.createdAt > UNCONFIRMED_LIFETIME
        )
          await remove(id);
      } finally {
        finish();
      }
    },
    [read, beginFilesSettle, patch, advance, remove, revoke],
  );

  const settle = useCallback(
    (sendTime: number) => {
      const id = settlementId({ account: accountKey, userId, sendTime });
      return navigator.locks.request(
        `file-settlement:${id}`,
        { ifAvailable: true },
        (lock) => (lock ? run(id, sendTime) : undefined),
      );
    },
    [accountKey, userId, run],
  );

  const begin = useCallback(
    async (
      sendTime: number,
      offset: number,
      files: { key: FileKey; expiresAt: bigint }[],
      removed: FileKey[] = [],
    ) => {
      if (!recipient) throw new Error("Conversation recipient is unknown");
      const entry: Settlement = {
        account: accountKey,
        recipient,
        userId,
        sendTime,
        offset,
        createdAt: Date.now(),
        files: files.map(({ key, expiresAt }) => ({
          key: stringifyExactJson(key),
          expiresAt: String(expiresAt),
          state: "uploading",
        })),
        removed: removed.map((key) => stringifyExactJson(key)),
      };
      const id = settlementId(entry);

      let release!: () => void;
      const held = new Promise<void>((resolve) => (release = resolve));
      await new Promise<void>((acquired) => {
        void navigator.locks.request(`file-settlement:${id}`, () => {
          acquired();
          return held;
        });
      });
      try {
        await change((all) => [
          ...all.filter((item) => settlementId(item) !== id),
          entry,
        ]);
      } catch (error) {
        release();
        throw error;
      }
      return {
        settle: (onStatuses?: (statuses: ChatFile["Status"][]) => void) =>
          run(id, sendTime, onStatuses)
            .catch(() => undefined)
            .finally(release),
        abandon: () => remove(id).then(release),
      };
    },
    [recipient, accountKey, userId, change, run, remove],
  );

  const resume = useCallback(async () => {
    const pending = (await load("pending_file_settlements")).filter(
      (entry) => entry.account === accountKey && entry.userId === userId,
    );
    await Promise.allSettled(pending.map((entry) => settle(entry.sendTime)));
  }, [load, accountKey, userId, settle]);

  const forget = useCallback(
    async (sendTime: number, keys: FileKey[]) => {
      const removed = await remove(
        settlementId({ account: accountKey, userId, sendTime }),
      );
      const shares = new Map(
        recipient
          ? keys.map((key) => [stringifyExactJson(key), { recipient, key }])
          : [],
      );

      for (const share of removed ? settlementShares(removed) : [])
        shares.set(stringifyExactJson(share.key), share);
      await revoke([...shares.values()]);
    },
    [remove, accountKey, userId, recipient, revoke],
  );

  return { begin, resume, forget };
}
