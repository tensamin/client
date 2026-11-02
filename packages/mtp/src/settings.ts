import type { BoundSendFn, ProtocolMessage } from "./mtpContext";
import type { MTPSubscriptionFunction } from "mtp";
import { mtp as schemas } from "@tensamin/shared/data";
import { log } from "@tensamin/shared/log";

export type UserBlob = {
  id: string;
  ciphertext: Uint8Array;
  revision: number;
  updatedAt: number;
};

export type ReceiptPolicy = {
  sendReadReceipts: boolean;
  sendReceivedReceipts: boolean;
  revision: number;
};

export type MessageStoragePolicy = {
  historyMode: "retain" | "delete_after_client_delivery";
  retentionMs: number | null;
  revision: number;
};

export type SyncedSetting = {
  id: number;
  scope: "user" | "contact" | "community";
  target: string;
  name: string;
  payload: string;
  revision: number;
};

export type UserAsset = {
  id: string;
  size: number;
  sha256: Uint8Array;
  mimeType: string;
  revision: number;
  createdAt: number;
  updatedAt: number;
};

function setting(
  data: ProtocolMessage<"SyncedSettingGet">["data"],
): SyncedSetting {
  return {
    id: data.SettingId,
    scope: data.SettingScope,
    target: data.SettingTarget,
    name: data.SettingsName,
    payload: data.Payload,
    revision: data.VersionNumber,
  };
}

function asset(
  data: ProtocolMessage<"UserAssetUploadCommit">["data"],
): UserAsset {
  return {
    id: data.AssetId,
    size: data.Size,
    sha256: data.Sha256,
    mimeType: data.MimeType,
    revision: data.VersionNumber,
    createdAt: data.CreatedAt,
    updatedAt: data.UpdatedAt,
  };
}

function expect<Type extends keyof typeof schemas & string>(
  type: Type,
  response: ProtocolMessage,
): ProtocolMessage<Type> {
  if (response.type !== type) {
    throw new Error(`Expected ${type}, received ${response.type}`);
  }
  return response as ProtocolMessage<Type>;
}

function blob(data: ProtocolMessage<"UserBlobGet">["data"]): UserBlob {
  return {
    id: data.BlobId,
    ciphertext: data.Blob,
    revision: data.VersionNumber,
    updatedAt: data.UpdatedAt,
  };
}

function blobMetadata(
  data: ProtocolMessage<"UserBlobList">["data"]["Blobs"][number],
): Omit<UserBlob, "ciphertext"> & {
  ciphertext?: Uint8Array;
} {
  return {
    id: data.BlobId,
    revision: data.VersionNumber,
    updatedAt: data.UpdatedAt,
  };
}

function ownedBytes(value: Uint8Array): Uint8Array<ArrayBuffer> {
  const bytes = new Uint8Array(value.byteLength);
  bytes.set(value);
  return bytes;
}

function logBlobPut({
  id,
  reason,
  value,
}: {
  id: string;
  reason: string;
  value: unknown;
}) {
  log(0, "settings", "cyan", "Executing UserBlobPut", {
    blobId: id,
    reason,
    value,
  });
}

function receipt(
  data: ProtocolMessage<"ReceiptPolicyGet">["data"],
): ReceiptPolicy {
  return {
    sendReadReceipts: data.SendReadReceipts,
    sendReceivedReceipts: data.SendReceivedReceipts,
    revision: data.VersionNumber,
  };
}

function storage(
  data: ProtocolMessage<"MessageStoragePolicyGet">["data"],
): MessageStoragePolicy {
  return {
    historyMode: data.MessageHistoryMode,
    retentionMs: data.MessageRetentionDuration ?? null,
    revision: data.VersionNumber,
  };
}

export function createSettingsClient({
  send,
  subscribe,
  clientState,
}: {
  send: BoundSendFn;
  subscribe: MTPSubscriptionFunction<typeof schemas>;
  clientState: ProtocolMessage<"AccountStateSnapshot">["data"] | null;
}) {
  return {
    async createBlob(
      id: string,
      ciphertext: Uint8Array,
      change: { reason: string; value: unknown },
    ) {
      logBlobPut({ id, ...change });
      const stored = expect(
        "UserBlobPut",
        await send("UserBlobPut", {
          BlobId: id,
          Blob: ownedBytes(ciphertext),
          ExpectedRevision: 0,
        }),
      ).data;
      return {
        id: stored.BlobId,
        ciphertext,
        revision: stored.VersionNumber,
        updatedAt: stored.UpdatedAt,
      };
    },
    async updateBlob(
      id: string,
      ciphertext: Uint8Array,
      expectedRevision: number,
      change: { reason: string; value: unknown },
    ) {
      logBlobPut({ id, ...change });
      const stored = expect(
        "UserBlobPut",
        await send("UserBlobPut", {
          BlobId: id,
          Blob: ownedBytes(ciphertext),
          ExpectedRevision: expectedRevision,
        }),
      ).data;
      return {
        id: stored.BlobId,
        ciphertext,
        revision: stored.VersionNumber,
        updatedAt: stored.UpdatedAt,
      };
    },
    async getBlob(id: string) {
      return blob(
        expect("UserBlobGet", await send("UserBlobGet", { BlobId: id })).data,
      );
    },
    async listBlobs() {
      return expect(
        "UserBlobList",
        await send("UserBlobList", {}),
      ).data.Blobs.map(blobMetadata);
    },
    async deleteBlob(id: string, expectedRevision: number) {
      return (
        expect(
          "UserBlobDelete",
          await send("UserBlobDelete", {
            BlobId: id,
            ExpectedRevision: expectedRevision,
          }),
        ).data.VersionNumber ?? null
      );
    },
    async setSetting(value: Omit<SyncedSetting, "id" | "revision">) {
      return setting(
        expect(
          "SyncedSettingSet",
          await send("SyncedSettingSet", {
            SettingScope: value.scope,
            SettingTarget: value.target,
            SettingsName: value.name,
            Payload: value.payload,
          }),
        ).data,
      );
    },
    async getSetting(
      scope: SyncedSetting["scope"],
      target: string,
      name: string,
    ) {
      return setting(
        expect(
          "SyncedSettingGet",
          await send("SyncedSettingGet", {
            SettingScope: scope,
            SettingTarget: target,
            SettingsName: name,
          }),
        ).data,
      );
    },
    async deleteSetting(
      scope: SyncedSetting["scope"],
      target: string,
      name: string,
    ) {
      return expect(
        "SyncedSettingDelete",
        await send("SyncedSettingDelete", {
          SettingScope: scope,
          SettingTarget: target,
          SettingsName: name,
        }),
      ).data;
    },
    async listSettings() {
      return expect(
        "SyncedSettingsList",
        await send("SyncedSettingsList", {}),
      ).data.Settings.map(setting);
    },
    async startAssetUpload(
      uploadId: string,
      value: {
        id: string;
        size: number;
        sha256: Uint8Array;
        mimeType: string;
      },
    ) {
      return expect(
        "UserAssetUploadStart",
        await send("UserAssetUploadStart", {
          UploadId: uploadId,
          AssetId: value.id,
          Size: value.size,
          Sha256: ownedBytes(value.sha256),
          MimeType: value.mimeType,
        }),
      ).data;
    },
    async uploadAssetChunk(
      uploadId: string,
      offset: number,
      bytes: Uint8Array,
    ) {
      return expect(
        "UserAssetUploadChunk",
        await send("UserAssetUploadChunk", {
          UploadId: uploadId,
          Offset: offset,
          Blob: ownedBytes(bytes),
        }),
      ).data;
    },
    async getAssetUploadStatus(uploadId: string) {
      return expect(
        "UserAssetUploadStatus",
        await send("UserAssetUploadStatus", {
          UploadId: uploadId,
        }),
      ).data;
    },
    async commitAssetUpload(uploadId: string) {
      return asset(
        expect(
          "UserAssetUploadCommit",
          await send("UserAssetUploadCommit", {
            UploadId: uploadId,
          }),
        ).data,
      );
    },
    async abortAssetUpload(uploadId: string) {
      expect(
        "UserAssetUploadAbort",
        await send("UserAssetUploadAbort", { UploadId: uploadId }),
      );
    },
    async getAssetChunk(id: string, offset: number, amount: number) {
      return expect(
        "UserAssetGetChunk",
        await send("UserAssetGetChunk", {
          AssetId: id,
          Offset: offset,
          Amount: amount,
        }),
      ).data;
    },
    async listAssets() {
      return expect(
        "UserAssetList",
        await send("UserAssetList", {}),
      ).data.Assets.map(asset);
    },
    async deleteAsset(id: string) {
      return expect(
        "UserAssetDelete",
        await send("UserAssetDelete", { AssetId: id }),
      ).data;
    },
    async blockUser(userId: number) {
      const data = expect(
        "UserBlock",
        await send("UserBlock", { BlockedUserId: userId }),
      ).data;
      return { userId: data.BlockedUserId, revision: data.VersionNumber };
    },
    async unblockUser(userId: number) {
      expect(
        "UserUnblock",
        await send("UserUnblock", { BlockedUserId: userId }),
      );
    },
    async getBlockedUsers() {
      return expect("BlockedUsersGet", await send("BlockedUsersGet", {})).data
        .BlockedUserIds;
    },
    async getReceiptPolicy() {
      if (!clientState) throw new Error("Client state is unavailable");
      return {
        sendReadReceipts: clientState.SendReadReceipts,
        sendReceivedReceipts: clientState.SendReceivedReceipts,
        revision: clientState.VersionNumber,
      };
    },
    async setReceiptPolicy(policy: Omit<ReceiptPolicy, "revision">) {
      return receipt(
        expect(
          "ReceiptPolicySet",
          await send("ReceiptPolicySet", {
            SendReadReceipts: policy.sendReadReceipts,
            SendReceivedReceipts: policy.sendReceivedReceipts,
          }),
        ).data,
      );
    },
    async getMessageStoragePolicy() {
      return storage(
        expect(
          "MessageStoragePolicyGet",
          await send("MessageStoragePolicyGet", {}),
        ).data,
      );
    },
    async setMessageStoragePolicy(
      policy: Omit<MessageStoragePolicy, "revision">,
    ) {
      return storage(
        expect(
          "MessageStoragePolicySet",
          await send("MessageStoragePolicySet", {
            MessageHistoryMode: policy.historyMode,
            ...(policy.retentionMs === null
              ? {}
              : { MessageRetentionDuration: policy.retentionMs }),
          }),
        ).data,
      );
    },
    async loadSnapshot() {
      const [blobs, blockedUserIds, receiptPolicy, messageStoragePolicy] =
        await Promise.all([
          this.listBlobs(),
          this.getBlockedUsers(),
          this.getReceiptPolicy(),
          this.getMessageStoragePolicy(),
        ]);
      return { blobs, blockedUserIds, receiptPolicy, messageStoragePolicy };
    },
    subscribeBlobChanges(
      handler: (
        event:
          | { id: string; revision: number; deleted: true }
          | {
              id: string;
              revision: number;
              updatedAt: number;
              ciphertext: Uint8Array;
              deleted: false;
            },
      ) => void,
    ) {
      return subscribe("UserBlobChanged", ({ data }) =>
        handler(
          data.Deleted
            ? { id: data.BlobId, revision: data.VersionNumber, deleted: true }
            : {
                id: data.BlobId,
                revision: data.VersionNumber,
                updatedAt: data.UpdatedAt,
                ciphertext: data.Blob,
                deleted: false,
              },
        ),
      );
    },
    subscribeSettingChanges(
      handler: (
        event: SyncedSetting | { deletedIds: number[]; revision: number },
      ) => void,
    ) {
      return subscribe("SyncedSettingChanged", ({ data }) => {
        handler(
          "DeletedSettingIds" in data
            ? {
                deletedIds: data.DeletedSettingIds,
                revision: data.VersionNumber,
              }
            : setting(data),
        );
      });
    },
    subscribeAssetChanges(
      handler: (event: UserAsset & { deleted: boolean }) => void,
    ) {
      return subscribe("UserAssetChanged", ({ data }) =>
        handler({ ...asset(data), deleted: data.Deleted }),
      );
    },
    subscribeBlockedUserChanges(
      handler: (event: {
        userId: number;
        revision: number;
        deleted: boolean;
      }) => void,
    ) {
      return subscribe("BlockedUsersChanged", ({ data }) =>
        handler({
          userId: data.BlockedUserId,
          revision: data.VersionNumber,
          deleted: data.Deleted,
        }),
      );
    },
    subscribeReceiptPolicy(handler: (policy: ReceiptPolicy) => void) {
      return subscribe("ReceiptPolicyChanged", ({ data }) =>
        handler(receipt(data)),
      );
    },
    subscribeMessageStoragePolicy(
      handler: (policy: MessageStoragePolicy) => void,
    ) {
      return subscribe("MessageStoragePolicyChanged", ({ data }) =>
        handler(storage(data)),
      );
    },
  };
}

export type SettingsClient = ReturnType<typeof createSettingsClient>;
