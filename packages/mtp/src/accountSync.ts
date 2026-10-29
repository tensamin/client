import { z } from "zod";
import { mtp } from "@tensamin/shared/data";
import {
  syncRecord,
  syncScope,
  type SyncRecord,
  type SyncScope,
} from "@tensamin/shared/accountSync";
import { setDatabaseEntry } from "@tensamin/shared/indexedDb";
import { encodeSecureValue } from "@tensamin/storage/secure";

const integer = z
  .string()
  .regex(/^-?\d+$/)
  .transform(Number)
  .pipe(z.number().int().min(0).max(Number.MAX_SAFE_INTEGER));
const number = (value: unknown) => integer.parse(value);

export function projectAccountState(
  scope: SyncScope,
  head: number,
  records: SyncRecord[],
) {
  const state: Record<string, unknown> = {
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
      LastMessageAt: number;
      CreatedAt: number;
      Notifications: number;
      Messages: unknown[];
    }
  >();
  const aliases = new Map<string, number>();
  for (const { entity, value } of records) {
    if (entity !== "contact") continue;
    const id = number(value.principal_handle);
    const principal = syncScope.shape.principal.parse(
      value.principal_handle_identity,
    );
    aliases.set(`${principal.authority}#${principal.user_id}`, id);
    contacts.set(id, {
      UserId: id,
      LastMessageAt: number(value.last_message_at),
      CreatedAt: number(value.created_at),
      Notifications: number(value.notifications),
      Messages: [],
    });
  }
  for (const { entity, value } of records) {
    if (entity === "message") {
      if (value.history_deleted === "1" || value.deleted_by_external === "1")
        continue;
      const partner = number(value.external_principal);
      const message = {
        Content: z.base64().parse(value.content),
        SendTime: number(value.message_time),
        SenderId:
          value.sent_by_self === "1" ? scope.principal.user_id : partner,
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
              SenderId:
                principal.authority === scope.principal.authority &&
                principal.user_id === scope.principal.user_id
                  ? scope.principal.user_id
                  : (aliases.get(
                      `${principal.authority}#${principal.user_id}`,
                    ) ?? principal.user_id),
            };
          }),
      };
      contacts.get(partner)?.Messages.push(message);
      (state.Messages as unknown[]).push(message);
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
    }
  }
  state.Contacts = [...contacts.values()].sort(
    (first, second) => second.LastMessageAt - first.LastMessageAt,
  );
  return mtp.AccountStateSnapshot.response.parse(state);
}

export async function persistAccountSnapshot(
  scope: SyncScope,
  head: number,
  records: SyncRecord[],
) {
  const snapshot = { scope, head, records };
  await setDatabaseEntry(
    "cache",
    `account-sync:${scope.principal.authority}:${scope.principal.user_id}:${scope.device_id}`,
    await encodeSecureValue(snapshot),
  );
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
