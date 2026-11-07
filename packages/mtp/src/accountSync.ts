import { z } from "zod";
import {
  accountStateSnapshot,
  mtp,
  type presenceSnapshotSchema,
} from "@tensamin/shared/data";
import {
  syncRecord,
  syncScope,
  type SyncRecord,
  type SyncScope,
  ACCOUNT_MESSAGE_PREVIEW_LIMIT,
} from "@tensamin/shared/accountSync";
import { getDatabaseEntry, setDatabaseEntry } from "@tensamin/shared/indexedDb";
import { decodeSecureValue, encodeSecureValue } from "@tensamin/storage/secure";
import { encodePrincipal } from "@tensamin/shared/principal";
import { base64ToBytes, type MTPRequestFunction } from "mtp";
import { isSecureEnvelope } from "@tensamin/storage/secure";
import { AccountJournal } from "./accountJournal";

const cacheBinding = z.strictObject({
  user_id: syncScope.shape.principal.shape.user_id,
  device_id: syncScope.shape.device_id,
  omega_url: z.url(),
  credential_sha256: z.string().regex(/^[a-f0-9]{64}$/),
});

export type AccountCacheBinding = z.infer<typeof cacheBinding>;

export async function accountCacheBinding({
  userId,
  keyring,
  deviceId,
  omegaUrl,
}: {
  userId: number;
  keyring: string;
  deviceId: string;
  omegaUrl: string;
}): Promise<AccountCacheBinding> {
  const url = new URL(omegaUrl);
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  ) {
    throw new Error("Invalid account cache origin");
  }
  const decoded = base64ToBytes(keyring);
  const bytes = new Uint8Array(decoded);
  decoded.fill(0);
  try {
    if (!bytes.length) throw new Error("Missing account credential");
    const hash = new Uint8Array(
      await globalThis.crypto.subtle.digest("SHA-256", bytes),
    );
    return cacheBinding.parse({
      user_id: userId,
      device_id: deviceId,
      omega_url: `${url.origin}${url.pathname.replace(/\/+$/, "")}/`,
      credential_sha256: [...hash]
        .map((byte) => byte.toString(16).padStart(2, "0"))
        .join(""),
    });
  } finally {
    bytes.fill(0);
  }
}

function offlineScopeKey(binding: AccountCacheBinding) {
  return `account-scope:v1:${JSON.stringify(cacheBinding.parse(binding))}`;
}

// Only the authenticated synchronization owner writes this locator, after its
// snapshot commits. It is not a separate cursor or an authorization credential.
export async function persistAccountScope(
  binding: AccountCacheBinding,
  scope: SyncScope,
) {
  scope = syncScope.parse(scope);
  if (
    scope.principal.user_id !== binding.user_id ||
    scope.device_id !== binding.device_id
  ) {
    throw new Error("Account cache scope does not match the credential");
  }
  await setDatabaseEntry(
    "cache",
    offlineScopeKey(binding),
    await encodeSecureValue({ binding, scope }),
  );
}

export async function loadOfflineAccountState(binding: AccountCacheBinding) {
  const stored = await getDatabaseEntry("cache", offlineScopeKey(binding));
  if (!isSecureEnvelope(stored)) return null;
  let decoded: unknown;
  try {
    decoded = await decodeSecureValue(stored);
  } catch {
    return null;
  }
  const locator = z
    .strictObject({ binding: cacheBinding, scope: syncScope })
    .safeParse(decoded);
  if (
    !locator.success ||
    JSON.stringify(locator.data.binding) !==
      JSON.stringify(cacheBinding.parse(binding)) ||
    locator.data.scope.principal.user_id !== binding.user_id ||
    locator.data.scope.device_id !== binding.device_id
  )
    return null;
  const journal = await AccountJournal.load(locator.data.scope);
  if (journal) {
    if (!navigator.locks)
      throw new Error("Account journal reads require Web Locks");
    return navigator.locks.request(
      accountSnapshotKey(locator.data.scope),
      { mode: "shared" },
      async () => {
        const current = await AccountJournal.load(locator.data.scope);
        return current ? projectAccountJournal(current) : null;
      },
    );
  }
  const snapshot = await loadAccountSnapshot(locator.data.scope);
  return snapshot
    ? projectAccountState(snapshot.scope, snapshot.head, snapshot.records)
    : null;
}

const integer = z
  .string()
  .regex(/^-?\d+$/)
  .transform(Number)
  .pipe(z.number().int().min(0).max(Number.MAX_SAFE_INTEGER));
const number = (value: unknown) => integer.parse(value);

function accountProjection(scope: SyncScope, head: number) {
  const committedChatEpochs: { chatId: string; version: number }[] = [];
  const messagePartners = new Map<unknown, number>();
  const state: Record<string, unknown> = {
    Scope: scope,
    VersionNumber: head,
    Contacts: [],
    Messages: [],
    Settings: [],
    BlockedUserIds: [],
    Communities: [],
    Calls: [],
  };
  const contacts = new Map<
    number,
    {
      UserId: number;
      Principal: string;
      LastMessageAt: number;
      CreatedAt: number;
      Notifications: number;
      Messages: unknown[];
    }
  >();
  const apply = ({ entity, value }: SyncRecord) => {
    if (entity === "contact") {
      const id = number(value.principal_handle);
      const principal = syncScope.shape.principal.parse(
        value.principal_handle_identity,
      );
      contacts.set(id, {
        UserId: id,
        Principal: encodePrincipal(principal),
        LastMessageAt:
          value.last_message_at === null ? 0 : number(value.last_message_at),
        CreatedAt: number(value.created_at),
        Notifications: number(value.notifications),
        Messages: [],
      });
    } else if (entity === "message") {
      if (value.history_deleted === "1" || value.deleted_by_external === "1")
        return;
      const partner = number(value.external_principal);
      const message = {
        Content: z.base64().parse(value.content),
        SendTime: number(value.message_time),
        SenderId:
          value.sent_by_self === "1" ? scope.principal.user_id : partner,
        Principal:
          value.sent_by_self === "1"
            ? encodePrincipal(scope.principal)
            : contacts.get(partner)?.Principal,
        MessageState: value.message_state,
        VersionNumber: number(value.key_version),
        RelayMessageId: value.relay_message_id ?? undefined,
        ReplyId: value.reply_to == null ? undefined : number(value.reply_to),
        Edited: number(value.edited_count) > 0,
        Reactions: z
          .array(
            z.object({
              reaction: z.string(),
              principal: syncScope.shape.principal,
            }),
          )
          .parse(value.reactions)
          .map(({ reaction, principal }) => {
            return {
              Reaction: reaction,
              Principal: encodePrincipal(principal),
            };
          }),
      };
      const messages = state.Messages as (typeof message)[];
      messages.push(message);
      messagePartners.set(message, partner);
      messages.sort((first, second) => second.SendTime - first.SendTime);
      if (messages.length > ACCOUNT_MESSAGE_PREVIEW_LIMIT)
        messagePartners.delete(messages.pop());
    } else if (entity === "setting" && value.deleted !== "1") {
      (state.Settings as unknown[]).push({
        SettingId: number(value.id),
        SettingScope: value.scope_type,
        SettingTarget: value.scope_key,
        SettingsName: value.name,
        Payload: value.payload,
        VersionNumber: number(value.revision),
      });
    } else if (entity === "blocked_user") {
      (state.BlockedUserIds as number[]).push(number(value.blocked_principal));
    } else if (entity === "receipt_policy") {
      state.SendReadReceipts = value.send_read_receipts === "1";
      state.SendReceivedReceipts = value.send_received_receipts === "1";
    } else if (entity === "message_storage_policy") {
      state.MessageHistoryMode = value.history_mode;
      if (value.retention_duration_ms != null)
        state.MessageRetentionDuration = number(value.retention_duration_ms);
    } else if (entity === "chat_secret") {
      committedChatEpochs.push({
        chatId: z.string().min(1).parse(value.chat_id),
        version: z.number().int().positive().parse(number(value.version)),
      });
    }
  };
  const finish = () => {
    for (const message of state.Messages as unknown[]) {
      const partner = messagePartners.get(message);
      if (partner !== undefined) contacts.get(partner)?.Messages.push(message);
    }
    state.Contacts = [...contacts.values()].sort(
      (first, second) => second.LastMessageAt - first.LastMessageAt,
    );
    return {
      ...accountStateSnapshot.parse(state),
      committedChatEpochs,
      callsAndCommunitiesLoaded: false,
      messageHistoryComplete: false,
    };
  };
  return { apply, finish };
}

export function projectAccountState(
  scope: SyncScope,
  head: number,
  records: SyncRecord[],
) {
  const projection = accountProjection(scope, head);
  for (const record of records)
    if (record.entity === "contact") projection.apply(record);
  for (const record of records)
    if (record.entity !== "contact") projection.apply(record);
  return projection.finish();
}

export async function projectAccountJournal(journal: AccountJournal) {
  const projection = accountProjection(journal.scope, journal.head);
  for await (const record of journal.records("contact"))
    projection.apply(record);
  for await (const record of journal.records())
    if (record.entity !== "contact") projection.apply(record);
  return projection.finish();
}

export type AccountState = ReturnType<typeof projectAccountState> & {
  presenceSnapshot?: z.infer<typeof presenceSnapshotSchema>;
};

export async function loadAccountRuntime(
  state: AccountState,
  client: { request: MTPRequestFunction<typeof mtp> },
): Promise<AccountState> {
  const [chats, communities] = await Promise.all([
    client.request("GetChats", {}),
    client.request("GetCommunities", {}),
  ]);
  if (chats.type !== "GetChats" || communities.type !== "GetCommunities")
    throw new Error("Account runtime state is unavailable");
  return {
    ...state,
    Calls: chats.data.Calls,
    Communities: communities.data.Communities,
    callsAndCommunitiesLoaded: true,
    presenceSnapshot: chats.data.PresenceSnapshotComplete
      ? {
          Uuid: chats.data.Uuid,
          Timestamp: chats.data.Timestamp,
          VersionNumber: chats.data.VersionNumber,
          UserStates: chats.data.UserStates,
          MissingUserIds: chats.data.MissingUserIds,
        }
      : undefined,
  };
}

export async function persistAccountSnapshot(
  scope: SyncScope,
  head: number,
  records: SyncRecord[],
) {
  const snapshot = { scope, head, records };
  await setDatabaseEntry(
    "cache",
    accountSnapshotKey(scope),
    await encodeSecureValue(snapshot),
  );
}

export function accountSnapshotKey(scope: SyncScope) {
  return `account-sync:${JSON.stringify(scope)}`;
}

export async function loadAccountSnapshot(scope: SyncScope) {
  const stored = await getDatabaseEntry("cache", accountSnapshotKey(scope));
  if (!isSecureEnvelope(stored)) return null;
  let decoded: unknown;
  try {
    decoded = await decodeSecureValue(stored);
  } catch {
    // Leave the old value intact until a complete authenticated replacement commits.
    return null;
  }
  const parsed = z
    .strictObject({
      scope: syncScope,
      head: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
      records: z.array(syncRecord),
    })
    .safeParse(decoded);
  if (
    !parsed.success ||
    JSON.stringify(parsed.data.scope) !== JSON.stringify(scope)
  ) {
    return null;
  }
  return parsed.data;
}

export function projectNativeAccountState(value: unknown) {
  const snapshot = z
    .object({
      scope: syncScope,
      head: z.number().int().nonnegative(),
      records: z.array(syncRecord),
    })
    .parse(value);
  return projectAccountState(snapshot.scope, snapshot.head, snapshot.records);
}
