import { getAppFocused, subscribeAppFocus } from "@tensamin/shared/focus";
import { log } from "@tensamin/shared/log";
import { AccountJournal } from "../accountJournal";
import { encodeAccountSync } from "@tensamin/shared/accountSyncWire";
import {
  accountSnapshotKey,
  loadAccountRuntime,
  loadOfflineAccountState,
  persistAccountScope,
  projectAccountJournal,
  type AccountCacheBinding,
  type AccountState,
} from "../accountSync";

import { INITIAL_SYNC_TIMEOUT } from "../values";

import { type BrowserMtpClient } from "./client";
import { abortError, withDeadline } from "./deadline";

export async function initializeAccountState(
  client: BrowserMtpClient,
  signal: AbortSignal,
  binding: AccountCacheBinding,
  syncTimeoutMs = INITIAL_SYNC_TIMEOUT,
  forceSnapshot = false,
): Promise<AccountState> {
  const userId = binding.user_id;
  const deviceId = binding.device_id;
  signal.throwIfAborted();
  const dictionary = client.dictionaryIdentity?.fingerprint;

  if (!dictionary) throw new Error("MTP dictionary identity is unavailable");
  const exchange = async (request: object) => {
    signal.throwIfAborted();

    if (!getAppFocused()) throw new Error("Foreground synchronization paused");
    const response = await withDeadline(
      client.request("AccountStateRequest", {
        SyncPayload: encodeAccountSync(request),
      }),
      syncTimeoutMs,
      "Account synchronization timed out",
      signal,
    );

    if (response.type !== "AccountStateSnapshot")
      throw new Error("Unexpected account sync response");

    return response.data;
  };

  const discovered = await exchange({
    operation: "discover",
    device_id: deviceId,
    dictionary,
  });

  if (
    discovered.state !== "scope" ||
    discovered.scope.principal.user_id !== userId ||
    discovered.scope.dictionary !== dictionary ||
    discovered.scope.device_id !== deviceId
  ) {
    throw new Error(
      "Account synchronization scope does not match this session",
    );
  }

  const scope = discovered.scope;

  if (!navigator.locks)
    throw new Error("Account synchronization requires Web Locks");
  const state = await navigator.locks.request(
    accountSnapshotKey(scope),
    { signal },
    async () => {
      const stored = await AccountJournal.load(scope);
      const resumable = forceSnapshot ? null : stored;
      const after = resumable?.head ?? 0;
      let resuming = resumable !== null;
      let journal = resumable ?? (await AccountJournal.begin(scope, signal));
      let staging = resumable === null;

      try {
        let sequence = after;
        let page: { id: string; offset: number } | null = null;
        let head: number | null = null;
        let floor: number | null = null;
        let pageId: string | null = null;

        for (;;) {
          const response = await exchange(
            resuming
              ? {
                  operation: "delta",
                  after: { scope, sequence: after },
                  page,
                  limit: 128,
                }
              : {
                  operation: "snapshot",
                  scope,
                  page,
                  limit: 128,
                },
          );

          if (response.state === "unavailable") {
            if (resuming && response.error === "snapshot_required") {
              resuming = false;
              journal = await AccountJournal.begin(scope, signal);
              staging = true;
              page = null;
              head = null;
              floor = null;
              pageId = null;
              continue;
            }

            throw new Error(`Account synchronization: ${response.error}`);
          }

          if (
            (response.state !== "snapshot" && response.state !== "delta") ||
            (resuming
              ? response.state !== "delta"
              : response.state !== "snapshot") ||
            JSON.stringify(response.scope) !== JSON.stringify(scope) ||
            response.floor > response.head ||
            (resuming &&
              (response.floor > after || response.head < sequence)) ||
            (head !== null && head !== response.head) ||
            (floor !== null && floor !== response.floor) ||
            (pageId !== null && pageId !== response.page_id)
          ) {
            throw new Error(
              "Account synchronization page does not match its scope",
            );
          }

          head = response.head;
          floor = response.floor;
          pageId = response.page_id;
          const items =
            response.state === "snapshot" ? response.records : response.events;

          if (response.state === "snapshot") {
            await journal.append(response.records, signal);
          } else {
            for (const event of response.events) {
              if (
                event.sequence !== sequence + 1 ||
                event.sequence > head ||
                event.event_id !==
                  `${scope.principal.authority}:${scope.principal.user_id}:${event.sequence}`
              )
                throw new Error("Account delta is not contiguous");

              if (event.operation === "delete") {
                if (event.record !== null)
                  throw new Error("Account deletion contains a record");
              } else {
                if (
                  !event.record ||
                  event.record.entity !== event.entity ||
                  event.record.key !== event.key
                ) {
                  throw new Error(
                    "Account delta record does not match its event",
                  );
                }
              }

              sequence = event.sequence;
            }

            await journal.apply(
              response.events.map((event) => ({
                entity: event.entity,
                key: event.key,
                record: event.record,
              })),
              sequence,
              signal,
            );
          }

          if (!response.next) break;

          if (
            response.next.id !== pageId ||
            items.length === 0 ||
            response.next.offset !== (page?.offset ?? 0) + items.length
          ) {
            throw new Error(
              "Account synchronization returned an invalid page token",
            );
          }

          page = response.next;
        }

        if (resuming && sequence !== head)
          throw new Error("Account delta omitted events");
        signal.throwIfAborted();

        if (!getAppFocused())
          throw new Error("Foreground synchronization paused");
        const state = {
          ...(await projectAccountJournal(journal, undefined, signal)),
          VersionNumber: head,
        };
        // Activation commits only after all snapshot pages are durable and valid. Delta pages commit records with their own contiguous local checkpoint.
        await journal.commit(head, signal);
        staging = false;
        await persistAccountScope(binding, scope);

        if (stored && stored.generation !== journal.generation)
          await stored.discard();

        if (signal.aborted) throw abortError(signal);
        const cursor = { scope, sequence: head };
        const acknowledged = await exchange({
          operation: "acknowledge",
          cursor,
          page_id: pageId,
        });

        if (
          acknowledged.state !== "acknowledged" ||
          JSON.stringify(acknowledged.cursor) !== JSON.stringify(cursor)
        ) {
          throw new Error(
            "Account synchronization acknowledgement does not match",
          );
        }

        return state;
      } finally {
        if (staging) await journal.discard();
      }
    },
  );
  signal.throwIfAborted();

  if (!getAppFocused()) throw new Error("Foreground synchronization paused");

  return withDeadline(
    loadAccountRuntime(state, client),
    syncTimeoutMs,
    "Account runtime state loading timed out",
    signal,
  );
}

export async function loadConnectionCache(
  binding: AccountCacheBinding,
  signal: AbortSignal,
) {
  let cached: AccountState | null = null;
  let forceSnapshot = false;
  const cacheAbort = new AbortController();
  const stopCacheVisibility = subscribeAppFocus(() => {
    if (!getAppFocused())
      cacheAbort.abort(new Error("Saved-state projection paused"));
  });

  try {
    if (getAppFocused())
      cached = await loadOfflineAccountState(
        binding,
        AbortSignal.any([signal, cacheAbort.signal]),
      );
  } catch (error) {
    if (!cacheAbort.signal.aborted && !signal.aborted) {
      forceSnapshot = true;
      log(
        1,
        "mtp",
        "yellow",
        "Saved account state could not be projected; fetching a fresh snapshot",
        error,
      );
    }
  } finally {
    stopCacheVisibility();
  }

  return { cached, forceSnapshot };
}
