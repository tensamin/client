import { z } from "zod";
import type { Theme, ThemeDesign } from "@nonanium/ui";
import { syncResponse, syncScope } from "./accountSync";

import {
  settingsStorageDefaults,
  type SettingsStorageDefaults,
} from "./settings";

const fileFromMessage = z.object({
  name: z.string(),
  id: z.uuidv4(),
  type: z.enum(["image", "image_top_right", "file"]),
});

const bytesLike = z.union([
  z.instanceof(Uint8Array),
  z.array(z.number().int().min(0).max(255)),
  z.base64(),
]);

const protocolBytes = z.instanceof(Uint8Array);

const sessionUuid = z.uuidv4();
const positiveId = z.number().int().positive();
// WASM byte views may use ArrayBufferLike; keep request inputs compatible.
const provisioningBytes = z.custom<Uint8Array>(
  (value) => value instanceof Uint8Array,
) as z.ZodType<Uint8Array>;
const nonEmptyBytes = provisioningBytes.refine(
  (value) => value.byteLength >= 1,
);
const base64Key = z.base64();
const opaqueMessage = nonEmptyBytes;

export const provisioningMethodSchema = z.enum([
  "password",
  "qr-contact-created",
  "qr-owner-created",
]);
export const provisioningRoleSchema = z.enum(["contact", "owner"]);
export const provisioningCreatedSchema = z.object({
  Timestamp: z.number().positive().optional(),
  Uuid: sessionUuid,
  ProvisioningParticipantId: positiveId,
  ProvisioningMethod: provisioningMethodSchema,
  ProvisioningRole: provisioningRoleSchema,
});
export const provisioningPeerJoinedSchema = z.object({
  Uuid: sessionUuid,
  ProvisioningParticipantId: positiveId,
  ProvisioningRole: provisioningRoleSchema,
  PublicKey: base64Key,
});
export const provisioningAccountBoundSchema = z.object({
  Uuid: sessionUuid,
  UserId: positiveId,
  Username: z.string().min(1).max(15),
  IotaId: positiveId,
  Principal: z.string().min(1),
  PublicKey: base64Key,
});
export const provisioningCredentialSchema = z.object({
  Uuid: sessionUuid,
  ProvisioningMethod: provisioningMethodSchema,
  UserId: positiveId,
  IotaId: positiveId,
  EncryptedCredential: nonEmptyBytes,
  Sha256: provisioningBytes.refine((value) => value.byteLength === 32),
});

export const provisioning = {
  ProvisioningCreate: {
    request: z.object({
      ProvisioningMethod: provisioningMethodSchema,
      ProvisioningRole: provisioningRoleSchema,
      PublicKey: base64Key,
      Username: z.string().min(1).max(15).optional(),
      UserId: positiveId.optional(),
      Uuid: sessionUuid.optional(),
    }),
    response: provisioningCreatedSchema,
  },
  ProvisioningCreated: {
    request: z.object({}).optional(),
    response: provisioningCreatedSchema,
  },
  ProvisioningJoin: {
    request: z.object({
      Uuid: sessionUuid,
      ProvisioningRole: provisioningRoleSchema,
      PublicKey: base64Key,
    }),
    response: provisioningPeerJoinedSchema.extend({ ClientId: positiveId }),
  },
  ProvisioningPeerJoined: {
    request: z.object({}).optional(),
    response: provisioningPeerJoinedSchema,
  },
  ProvisioningBindAccount: {
    request: z.object({
      Uuid: sessionUuid,
      Username: z.string().min(1).max(15).optional(),
      UserId: positiveId.optional(),
    }),
    response: provisioningAccountBoundSchema,
  },
  ProvisioningAccountBound: {
    request: z.object({}).optional(),
    response: provisioningAccountBoundSchema,
  },
  QrProvisioningConfirm: {
    request: z.object({ Uuid: sessionUuid }),
    response: z.object({ Uuid: sessionUuid.optional() }),
  },
  // Omikron enriches the Iota-bound copy with participant/user/Iota/key fields.
  PasswordProvisioningStart: {
    request: z.object({ Uuid: sessionUuid, OpaqueMessage: opaqueMessage }),
    response: z.object({ Uuid: sessionUuid, OpaqueMessage: opaqueMessage }),
  },
  PasswordProvisioningResponse: {
    request: z.object({}).optional(),
    response: z.object({ Uuid: sessionUuid, OpaqueMessage: opaqueMessage }),
  },
  // KE3 succeeds with a protected ProvisioningCredential frame; auth
  // failures arrive as ErrorNotAuthenticated with the same frame ID.
  PasswordProvisioningFinish: {
    request: z.object({ Uuid: sessionUuid, OpaqueMessage: opaqueMessage }),
    response: z.object({}).optional(),
  },
  // Validate protected payloads with provisioningCredentialSchema after opening.
  ProvisioningCredential: {
    request: provisioningCredentialSchema,
    response: z.unknown(),
  },
  ProvisioningComplete: {
    request: z.object({ Uuid: sessionUuid }),
    response: z.object({}),
  },
  ProvisioningCancel: {
    request: z.object({ Uuid: sessionUuid }),
    response: z.object({ Uuid: sessionUuid.optional() }),
  },
  PasswordEnrollmentStart: {
    request: z.object({ OpaqueMessage: opaqueMessage }),
    response: z.object({}),
  },
  PasswordEnrollmentResponse: {
    request: z.object({}).optional(),
    response: z.object({ Uuid: sessionUuid, OpaqueMessage: opaqueMessage }),
  },
  PasswordEnrollmentFinish: {
    request: z.object({
      Uuid: sessionUuid,
      OpaqueMessage: opaqueMessage,
      EncryptedCredential: nonEmptyBytes,
    }),
    response: z.object({}),
  },
  PasswordEnrollmentStatus: {
    request: z.object({}),
    response: z.object({ Enabled: z.boolean() }),
  },
  PasswordEnrollmentDisable: {
    request: z.object({}),
    response: z.object({ Enabled: z.literal(false) }),
  },
} as const;

export type ProvisioningMethod = z.infer<typeof provisioningMethodSchema>;
export type ProvisioningRole = z.infer<typeof provisioningRoleSchema>;
export type ProvisioningCreated = z.infer<typeof provisioningCreatedSchema>;
export type ProvisioningPeerJoined = z.infer<
  typeof provisioningPeerJoinedSchema
>;
export type ProvisioningAccountBound = z.infer<
  typeof provisioningAccountBoundSchema
>;
export type ProvisioningCredential = z.infer<
  typeof provisioningCredentialSchema
>;

function bytesFromProtocol(value: z.infer<typeof bytesLike>): Uint8Array {
  if (value instanceof Uint8Array) return value;
  if (Array.isArray(value)) return new Uint8Array(value);

  const bin = atob(value);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

const protocolBytesResponse = bytesLike.transform(bytesFromProtocol);

const blobId = z.string().refine((value) => {
  const length = new TextEncoder().encode(value).byteLength;
  return length >= 1 && length <= 256;
}, "BlobId must be between 1 and 256 UTF-8 bytes");
const revision = z.number().int().nonnegative();
const utf8Length = (value: string) =>
  new TextEncoder().encode(value).byteLength;
const assetId = z
  .string()
  .min(1)
  .refine((value) => utf8Length(value) <= 256);
const uploadId = z
  .string()
  .min(1)
  .refine((value) => utf8Length(value) <= 128);
const sha256 = protocolBytes.refine((value) => value.byteLength === 32);
const sha256Response = protocolBytesResponse.refine(
  (value) => value.byteLength === 32,
);
const syncedSetting = z.object({
  SettingId: z.number().int().positive(),
  SettingScope: z.enum(["user", "contact", "community"]),
  SettingTarget: z.string(),
  SettingsName: z.string().min(1),
  Payload: z.string().refine((value) => utf8Length(value) <= 16 * 1024 * 1024),
  VersionNumber: revision,
});
const userAssetMetadata = z.object({
  AssetId: assetId,
  Size: z.number().int().nonnegative(),
  Sha256: sha256Response,
  MimeType: z.string().min(1).max(255),
  VersionNumber: revision,
  CreatedAt: z.number(),
  UpdatedAt: z.number(),
});
const userAssetUploadStatus = z.object({
  UploadId: uploadId,
  AssetId: assetId,
  Size: z.number().int().nonnegative(),
  Sha256: sha256Response,
  MimeType: z.string().min(1).max(255),
  Offset: z.number().int().nonnegative(),
  State: z.enum(["uploading", "committed"]),
  VersionNumber: revision.optional(),
  CreatedAt: z.number(),
  UpdatedAt: z.number(),
  CommittedAt: z.number().optional(),
});
const userBlobMetadata = z.object({
  BlobId: blobId,
  VersionNumber: revision,
  UpdatedAt: z.number(),
});
const userBlobResponse = userBlobMetadata.extend({
  Blob: protocolBytesResponse.refine(
    (value) => value.byteLength <= 1_048_576,
    "Blob must not exceed 1 MiB",
  ),
});
const receiptPolicyResponse = z.object({
  SendReadReceipts: z.boolean(),
  SendReceivedReceipts: z.boolean(),
  VersionNumber: revision,
});
const messageStoragePolicyResponse = z.object({
  MessageHistoryMode: z.enum(["retain", "delete_after_client_delivery"]),
  MessageRetentionDuration: z
    .number()
    .int()
    .min(60_000)
    .max(31_536_000_000)
    .optional(),
  VersionNumber: revision,
});

const chatSecretResponse = z.object({
  UserId: z.string(),
  ChatId: z.string(),
  SecretId: z.string(),
  VersionNumber: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  EncryptedSecret: protocolBytes,
  KemCiphertext: protocolBytes,
  WrappingScheme: z.string(),
  CreatedAt: z.number(),
  UpdatedAt: z.number(),
});

const chatSecretRecipient = z.object({
  UserId: z.string(),
  EncryptedSecret: protocolBytes,
  KemCiphertext: protocolBytes,
});

const callSecretEnvelopeResponse = z.object({
  SecretId: z.string(),
  VersionNumber: z.number(),
  EncryptedSecret: protocolBytesResponse,
  KemCiphertext: protocolBytesResponse,
  WrappingScheme: z.string(),
});

const callSecretEnvelopeRequest = z.object({
  SecretId: z.string(),
  VersionNumber: z.number(),
  EncryptedSecret: protocolBytes,
  KemCiphertext: protocolBytes,
  WrappingScheme: z.string(),
});

export const Reaction = z.object({
  Reaction: z.string(),
  SenderId: z.number(),
});

export const Message = z.object({
  Principal: z.string().optional(),
  NotEncrypted: z.boolean().optional(),
  SenderId: z.number(),
  SendTime: z.number(),
  Content: z.base64(),
  VersionNumber: z.number().int().positive().default(1),
  RelayMessageId: z.string().optional(),
  Files: z.array(fileFromMessage).optional(),
  Tint: z.string().length(7).startsWith("#").optional(),
  Avatar: z.boolean().optional(),
  Display: z.boolean().optional(),
  ReplyId: z.number().optional(),
  UpdatedAt: z.number().optional(),
  ErrorType: z.string().optional(),
  MessageState: z
    .enum(["read", "received", "sent", "sending", "awaiting"]) // awaiting for 'internal' use
    .default("received"),
  Edited: z.boolean().optional(),
  Reactions: z.array(Reaction).optional(),
});

export const failedUser = {
  Display: "Failed",
  IotaId: 0,
  OmikronConnections: [],
  OnlineStatus: "user_borked",
  PublicKey: "",
  SubEnd: 0,
  SubLevel: 0,
  UserId: 0,
  Username: "unknown",
} as z.infer<typeof mtp.GetUserData.response>;

const authPayload = z.object({
  Communities: z.array(z.object({})).default([]),
  Contacts: z
    .array(
      z
        .object({
          LastMessageAt: z.number().default(0),
          CreatedAt: z.number().optional(),
          UserId: z.number(),
          Principal: z.string().optional(),
          Notifications: z.number().int().nonnegative().default(0),
          LastMessage: z
            .object({
              Content: z.base64(),
              SenderId: z.number(),
            })
            .optional(),
          Messages: z.array(Message).default([]),
        })
        .transform(({ Notifications, ...contact }) => ({
          ...contact,
          notifications: Notifications,
        })),
    )
    .default([]),
  Calls: z
    .array(
      z.object({
        CallId: z.string(),
        OmikronId: z.number(),
        CallSecret: callSecretEnvelopeResponse.optional(),
        CallMembers: z.array(z.number()),
        CallInvited: z.boolean().optional(),
        SenderId: z.number().optional(),
        CreatedAt: z.number().optional(),
      }),
    )
    .default([]),
});

const accountStateSnapshot = authPayload.extend({
  Scope: syncScope.optional(),
  VersionNumber: revision,
  Messages: z.array(Message).default([]),
  DeletedMessageIds: z.array(z.number()).default([]),
  DeletedContactIds: z.array(z.number()).default([]),
  BlockedUserIds: z.array(z.number().int().positive()).default([]),
  SendReadReceipts: z.boolean().default(true),
  SendReceivedReceipts: z.boolean().default(false),
  MessageHistoryMode: z
    .enum(["retain", "delete_after_client_delivery"])
    .default("retain"),
  MessageRetentionDuration: z
    .number()
    .int()
    .min(60_000)
    .max(31_536_000_000)
    .optional(),
  UserStates: z
    .array(
      z
        .object({
          UserId: z.number().int().positive(),
          UserState: z.enum([
            "user_online",
            "user_idle",
            "user_dnd",
            "user_wc",
            "user_offline",
            "iota_offline",
            "user_borked",
            "iota_online",
            "iota_borked",
          ]),
        })
        .nullable(),
    )
    .default([]),
  MissingUserIds: z.array(z.number().int().positive()).default([]),
  PresenceSnapshotComplete: z.boolean().default(false),
  Settings: z.array(syncedSetting).default([]),
});

export type Contacts = z.infer<typeof authPayload.shape.Contacts>;
export type Communities = z.infer<typeof authPayload.shape.Communities>;
export type Calls = z.infer<typeof authPayload.shape.Calls>;

// MTP
const userFields = {
  About: z.string().max(255).optional(),
  Avatar: z.string().optional(),
  Display: z.string().min(1).max(15),
  IotaId: z.number().optional(),
  OmikronConnections: z.array(z.number()),
  OmikronId: z.number().optional(),
  PublicKey: z.base64(),
  Status: z.string().max(15).optional(),
  SubEnd: z.number(),
  SubLevel: z.number(),
  UserId: z.number(),
  Username: z.string().min(1).max(15),
};

export const publicUserStateSchema = z.enum([
  "user_online",
  "user_idle",
  "user_dnd",
  "user_wc",
  "user_offline",
  "iota_offline",
]);

export const userPresencePreferenceSchema = z.enum([
  "user_online",
  "user_idle",
  "user_dnd",
  "user_wc",
  "user_invisible",
]);

export const clientUserStateSchema = z.union([
  publicUserStateSchema,
  userPresencePreferenceSchema,
]);

export const publicUserSchema = z.object({
  ...userFields,
  OnlineStatus: z.enum([
    "user_online",
    "user_idle",
    "user_dnd",
    "user_wc",
    "user_offline",
    "iota_offline",
    "user_borked",
    "iota_online",
    "iota_borked",
  ]),
});

export const accountUserSchema = z.object({
  ...userFields,
  OnlineStatus: userPresencePreferenceSchema,
});

export const userSchema = z.union([publicUserSchema, accountUserSchema]);

export const userStateEntrySchema = z.object({
  UserId: z.number().int().positive(),
  UserState: publicUserStateSchema,
});

const resolvedUser = z.object({
  Principal: z.string(),
  UserAddress: z.string(),
  UserId: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  AuthorityId: z.string(),
  NodeId: z.string().regex(/^iota:v1:[a-f0-9]{64}$/),
  PublicKey: z.base64(),
  SigningKeys: z.array(z.base64()).min(1),
  Username: z.string().optional(),
});

export const mtp = {
  UserResolve: {
    request: z.object({ UserAddress: z.string() }),
    response: resolvedUser,
  },
  UserResolved: {
    request: z.object({}).optional(),
    response: resolvedUser,
  },
  ...provisioning,
  ProvisioningBindAccount: {
    request: z.object({
      Uuid: z.uuidv4(),
      UserId: z.number().int().positive(),
    }),
    response: provisioningPeerJoinedSchema,
  },
  IdentificationResponse: {
    request: z.object({}).optional(),
    response: authPayload,
  },
  AccountStateRequest: {
    request: z.object({ Json: protocolBytes }),
    response: z
      .object({
        Json: protocolBytesResponse.refine(
          (value) => value.byteLength <= 1024 * 1024,
        ),
      })
      .transform(({ Json }) =>
        syncResponse.parse(
          JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Json)),
        ),
      ),
  },
  AccountStateSnapshot: {
    request: z.object({}).optional(),
    response: accountStateSnapshot,
  },
  AccountStateApplied: {
    request: z.object({}),
    response: z.object({}),
  },
  UserBlobPut: {
    request: z.object({
      BlobId: blobId,
      Blob: protocolBytes.refine((value) => value.byteLength <= 1_048_576),
      ExpectedRevision: revision.optional(),
    }),
    response: userBlobMetadata,
  },
  UserBlobGet: {
    request: z.object({ BlobId: blobId }),
    response: userBlobResponse,
  },
  UserBlobList: {
    request: z.object({}).optional(),
    response: z.object({ Blobs: z.array(userBlobMetadata) }),
  },
  UserBlobDelete: {
    request: z.object({
      BlobId: blobId,
      ExpectedRevision: revision.optional(),
    }),
    response: z.object({ VersionNumber: revision.optional() }),
  },
  UserBlobChanged: {
    request: z.object({}).optional(),
    response: z.discriminatedUnion("Deleted", [
      userBlobResponse.extend({ Deleted: z.literal(false) }),
      userBlobMetadata.pick({ BlobId: true, VersionNumber: true }).extend({
        Deleted: z.literal(true),
      }),
    ]),
  },
  SyncedSettingSet: {
    request: syncedSetting.pick({
      SettingScope: true,
      SettingTarget: true,
      SettingsName: true,
      Payload: true,
    }),
    response: syncedSetting,
  },
  SyncedSettingGet: {
    request: syncedSetting.pick({
      SettingScope: true,
      SettingTarget: true,
      SettingsName: true,
    }),
    response: syncedSetting,
  },
  SyncedSettingDelete: {
    request: syncedSetting.pick({
      SettingScope: true,
      SettingTarget: true,
      SettingsName: true,
    }),
    response: z.object({
      SettingId: z.number().int().positive().optional(),
      VersionNumber: revision.optional(),
    }),
  },
  SyncedSettingsList: {
    request: z.object({}).optional(),
    response: z.object({ Settings: z.array(syncedSetting) }),
  },
  SyncedSettingChanged: {
    request: z.object({}).optional(),
    response: z.union([
      syncedSetting,
      z.object({
        DeletedSettingIds: z.array(z.number().int().positive()),
        VersionNumber: revision,
      }),
    ]),
  },
  UserAssetUploadStart: {
    request: z.object({
      UploadId: uploadId,
      AssetId: assetId,
      Size: z.number().int().nonnegative(),
      Sha256: sha256,
      MimeType: z.string().min(1).max(255),
    }),
    response: userAssetUploadStatus,
  },
  UserAssetUploadChunk: {
    request: z.object({
      UploadId: uploadId,
      Offset: z.number().int().nonnegative(),
      Blob: protocolBytes.refine(
        (value) => value.byteLength > 0 && value.byteLength <= 8 * 1024 * 1024,
      ),
    }),
    response: userAssetUploadStatus,
  },
  UserAssetUploadStatus: {
    request: z.object({ UploadId: uploadId }),
    response: userAssetUploadStatus,
  },
  UserAssetUploadCommit: {
    request: z.object({ UploadId: uploadId }),
    response: userAssetMetadata,
  },
  UserAssetUploadAbort: {
    request: z.object({ UploadId: uploadId }),
    response: z.object({ UploadId: uploadId }),
  },
  UserAssetGetChunk: {
    request: z.object({
      AssetId: assetId,
      Offset: z.number().int().nonnegative(),
      Amount: z
        .number()
        .int()
        .positive()
        .max(8 * 1024 * 1024),
    }),
    response: userAssetMetadata.extend({
      Offset: z.number().int().nonnegative(),
      Blob: protocolBytesResponse.refine(
        (value) => value.byteLength <= 8 * 1024 * 1024,
      ),
    }),
  },
  UserAssetList: {
    request: z.object({}).optional(),
    response: z.object({ Assets: z.array(userAssetMetadata) }),
  },
  UserAssetDelete: {
    request: z.object({ AssetId: assetId }),
    response: userAssetMetadata.partial().required({ AssetId: true }),
  },
  UserAssetChanged: {
    request: z.object({}).optional(),
    response: userAssetMetadata.extend({ Deleted: z.boolean() }),
  },
  UserBlock: {
    request: z.object({ BlockedUserId: z.number().int().positive() }),
    response: z.object({
      BlockedUserId: z.number().int().positive(),
      VersionNumber: revision,
    }),
  },
  UserUnblock: {
    request: z.object({ BlockedUserId: z.number().int().positive() }),
    response: z.object({}),
  },
  BlockedUsersGet: {
    request: z.object({}).optional(),
    response: z.object({
      BlockedUserIds: z.array(z.number().int().positive()),
    }),
  },
  BlockedUsersChanged: {
    request: z.object({}).optional(),
    response: z.object({
      BlockedUserId: z.number().int().positive(),
      VersionNumber: revision,
      Deleted: z.boolean(),
    }),
  },
  ReceiptPolicyGet: {
    request: z.object({}).optional(),
    response: receiptPolicyResponse,
  },
  ReceiptPolicySet: {
    request: receiptPolicyResponse.omit({ VersionNumber: true }),
    response: receiptPolicyResponse,
  },
  ReceiptPolicyChanged: {
    request: z.object({}).optional(),
    response: receiptPolicyResponse,
  },
  MessageStoragePolicyGet: {
    request: z.object({}).optional(),
    response: messageStoragePolicyResponse,
  },
  MessageStoragePolicySet: {
    request: messageStoragePolicyResponse.omit({ VersionNumber: true }),
    response: messageStoragePolicyResponse,
  },
  MessageStoragePolicyChanged: {
    request: z.object({}).optional(),
    response: messageStoragePolicyResponse,
  },
  GetUserData: {
    request: z.object({
      UserId: z.number().optional(),
      Username: z.string().optional(),
    }),
    response: userSchema,
  },
  GetIotaData: {
    request: z
      .object({
        IotaId: z.number().int().positive().optional(),
        UserId: z.number().int().positive().optional(),
        Username: z.string().min(1).max(15).optional(),
      })
      .refine(
        ({ IotaId, UserId, Username }) =>
          [IotaId, UserId, Username].filter((value) => value !== undefined)
            .length === 1,
        "GetIotaData requires exactly one selector",
      ),
    response: z.object({
      IotaId: z.number().int().positive(),
      PublicKey: z.base64(),
      OmikronConnections: z.array(z.number().int().positive()).optional(),
      UserId: z.number().int().positive().optional(),
      Username: z.string().optional(),
    }),
  },
  GetStates: {
    request: z.object({
      SessionId: z.number().int().positive(),
      UserIds: z.array(z.number().int().positive()),
    }),
    response: z.object({
      SessionId: z.number().int().positive(),
      // Keep valid entries when one entry in a server snapshot is malformed.
      UserStates: z.array(userStateEntrySchema.nullable().catch(null)),
      MissingUserIds: z.array(z.number().int().positive()).optional(),
    }),
  },
  ClientChanged: {
    request: z.object({}).optional(),
    response: z.object({
      SessionId: z.number().int().positive(),
      UserId: z.number().int().positive(),
      UserState: clientUserStateSchema,
    }),
  },
  ChangeUserData: {
    request: z
      .object({
        About: userFields.About,
        Avatar: userFields.Avatar,
        Display: userFields.Display,
        OnlineStatus: userPresencePreferenceSchema,
        PublicKey: userFields.PublicKey,
        Status: userFields.Status,
        Username: userFields.Username,
      })
      .partial(),
    response: z.object({}),
  },
  MessageDelete: {
    request: z.object({
      ChatPartnerId: z.number(),
      SendTime: z.number(),
    }),
    response: z.object({}),
  },
  MessageDeleteLive: {
    request: z.object({}),
    response: z.object({
      ChatPartnerId: z.number(),
      SendTime: z.number(),
    }),
  },
  MessageEditLive: {
    request: z.object({}),
    response: z.object({
      Content: z.base64(),
      ChatPartnerId: z.number(),
      SendTime: z.number(),
      VersionNumber: z.number().int().positive().default(1),
    }),
  },
  MessageEdit: {
    request: z.object({
      Content: z.base64(),
      ChatPartnerId: z.number(),
      SendTime: z.number(),
      VersionNumber: z.number().int().positive().default(1),
    }),
    response: z.object({}),
  },
  MessageReactionAdd: {
    request: z.object({
      Reaction: z.string(),
      SendTime: z.number(),
      ChatPartnerId: z.number(),
    }),
    response: z.object(),
  },
  MessageReactionRemove: {
    request: z.object({
      Reaction: z.string(),
      SendTime: z.number(),
      ChatPartnerId: z.number(),
    }),
    response: z.object(),
  },
  MessageReactionLive: {
    request: z.object(),
    response: z.object({
      Reaction: z.string(),
      SendTime: z.number(),
      ChatPartnerId: z.number(),
      SenderId: z.number(),
      Accepted: z.boolean(),
    }),
  },
  MessageLive: {
    request: z.object({}).optional(),
    response: z
      .object({
        SenderId: z.number(),
        LastMessageAt: z.number().optional(),
        Notifications: z.number().int().nonnegative().optional(),
        SuppressNotification: z.boolean().optional(),
        Message: Message.extend({ SenderId: z.number().optional() }),
      })
      .transform(
        ({
          SenderId,
          LastMessageAt,
          Notifications,
          SuppressNotification,
          Message,
        }) => ({
          SenderId,
          LastMessageAt: LastMessageAt ?? Message.SendTime,
          notifications: Notifications,
          suppressNotification: SuppressNotification ?? false,
          Message: { ...Message, SenderId: Message.SenderId ?? SenderId },
        }),
      ),
  },
  ReadNotification: {
    request: z.object({
      ChatPartnerId: z.number().int().positive(),
      LastMessageAt: z.number().nonnegative(),
    }),
    response: z
      .object({
        ChatPartnerId: z.number().int().positive(),
        LastMessageAt: z.number().nonnegative(),
        Notifications: z.number().int().nonnegative(),
      })
      .transform(({ Notifications, ...contact }) => ({
        ...contact,
        notifications: Notifications,
      })),
  },
  PushNotification: {
    request: z.object({}).optional(),
    response: z
      .object({
        ChatPartnerId: z.number().int().positive(),
        LastMessageAt: z.number().nonnegative(),
        Notifications: z.number().int().nonnegative(),
      })
      .transform(({ Notifications, ...contact }) => ({
        ...contact,
        notifications: Notifications,
      })),
  },
  MessageGet: {
    request: z.object({
      SendTime: z.number(),
      ChatPartnerId: z.number().optional(),
    }),
    response: Message.extend({ Offset: z.number().optional() }).transform(
      ({ Offset, ...Message }) => ({ Message, Offset }),
    ),
  },
  MessagesGet: {
    request: z.object({
      UserId: z.number(),
      Amount: z.number(),
      Offset: z.number(),
    }),
    response: z.object({
      Messages: z.array(Message),
    }),
  },
  MessageSend: {
    request: z.object({
      Content: z.base64(),
      ReceiverId: z.number(),
      SendTime: z.number(),
      VersionNumber: z.number().int().positive().default(1),
      ReplyId: z.number().optional(),
      Files: z.array(fileFromMessage).optional(),
    }),
    response: z.object({}),
  },
  AddConversation: {
    request: z.object({
      ChatPartnerId: z.number().optional(),
      ChatPartnerName: z.string().min(1).max(15).optional(),
    }),
    response: z.object({}),
  },
  MessageState: {
    request: z.object({
      ChatPartnerId: z.number(),
      RelayMessageId: z.string(),
      EventAt: z.number(),
      MessageState: z.enum(["received", "read"]),
    }),
    response: z.object({
      ChatPartnerId: z.number(),
      MessageState: Message.shape.MessageState,
      SendTime: z.number(),
    }),
  },
  SessionActivitySet: {
    request: z.object({
      DeviceClass: z.enum(["desktop", "mobile", "web"]).optional(),
      NotificationCapable: z.boolean().optional(),
      Foreground: z.boolean().optional(),
    }),
    response: z.object({ Foreground: z.boolean().optional() }),
  },

  TAuthAuthorize: {
    request: z.object({
      AuthorizationRequest: z.string(),
      Enabled: z.boolean(),
    }),
    response: z.object({
      AppId: z.string(),
      AppName: z.string(),
      Domain: z.string(),
      RedirectUri: z.url(),
      Scopes: z.array(z.string()),
      State: z.string(),
      Locator: z.string(),
      AuthorizationCode: z.string().optional(),
    }),
  },
  TAuthGrantList: {
    request: z.object({}),
    response: z.object({ Json: z.string() }),
  },
  TAuthGrantRevoke: {
    request: z.object({ AppId: z.string() }),
    response: z.object({}),
  },
  TAuthGrantMetadataSet: {
    request: z.object({ AppId: z.string(), Json: z.string() }),
    response: z.object({}),
  },

  // Calls
  CallReserve: {
    request: z.object({}),
    response: z.object({ CallId: z.string(), OmikronId: z.number() }),
  },
  CallActivate: {
    request: z.object({
      CallId: z.string(),
      CallSecret: callSecretEnvelopeRequest,
    }),
    response: z.object({
      CallToken: z.string(),
      CallEndpoint: z.string(),
      OmikronId: z.number(),
      CreatedAt: z.number(),
    }),
  },
  CallEnded: {
    request: z.object({}).optional(),
    response: z.object({ CallId: z.string() }),
  },
  CallToken: {
    request: z.object({
      CallId: z.string(),
      CallSecret: callSecretEnvelopeRequest.optional(),
    }),
    response: z.object({
      CallToken: z.string(),
      CallEndpoint: z.string(),
      OmikronId: z.number(),
      CreatedAt: z.number().optional(),
    }),
  },
  CallData: {
    request: z.object({
      CallId: z.string(),
    }),
    response: z.object({
      UserIds: z.array(z.number()),
      CreatedAt: z.number(),
      CallSecret: callSecretEnvelopeResponse,
    }),
  },
  CallInvite: {
    request: z.object({
      CallId: z.string(),
      CallSecret: callSecretEnvelopeRequest,
      ReceiverId: z.number(),
    }),
    response: z.object({
      CallId: z.string().optional(),
      CallSecret: callSecretEnvelopeResponse.optional(),
      SenderId: z.number().optional(),
      ReceiverId: z.number().optional(),
      OmikronId: z.number().optional(),
    }),
  },
  CallDisconnectUser: {
    request: z.object({
      CallId: z.string(),
      UserId: z.number(),
    }),
    response: z.object({}),
  },
  CallTimeoutUser: {
    request: z.object({
      CallId: z.string(),
      UserId: z.number(),
      Untill: z.number(),
    }),
    response: z.object({
      Timeout: z.number().optional(),
    }),
  },
  CallSetAnonymousJoining: {
    request: z.object({
      CallId: z.string(),
      Enabled: z.boolean(),
    }),
    response: z.object({
      CallId: z.string().optional(),
      Enabled: z.boolean().optional(),
      Link: z.string().optional(),
    }),
  },
  EndCall: {
    request: z.object({
      CallId: z.string(),
    }),
    response: z.object({}),
  },
  SetChatSecret: {
    request: z.object({
      ChatId: z.string(),
      SecretId: z.string(),
      VersionNumber: z.number(),
      WrappingScheme: z.string(),
      Recipients: z.array(chatSecretRecipient).min(1),
    }),
    response: z.object({}),
  },
  GetChatSecret: {
    request: z.object({
      UserId: z.string(),
      ChatId: z.string(),
      SecretId: z.string().optional(),
      VersionNumber: z.number().int().positive().optional(),
    }),
    response: chatSecretResponse,
  },
  ChatSecretResponse: {
    request: z.object({}).optional(),
    response: chatSecretResponse,
  },
  ChatSecretForward: {
    request: z.object({}).optional(),
    response: z.object({
      ChatId: z.string(),
      Principal: z.string(),
      UserAddress: z.string(),
      SecretId: z.string(),
      VersionNumber: z.number().int().positive(),
      Payload: z.literal("available"),
    }),
  },
  ErrorNoIota: {
    request: z.object({}).optional(),
    response: z.object({}),
  },
  ErrorNotSet: {
    request: z.object({}).optional(),
    response: z.object({}),
  },
} satisfies Record<string, { request: z.ZodType; response: z.ZodType }>;

export type MTP = typeof mtp;

// Storage
export type ChatPickerMediaGroup = {
  id: string;
  name: string;
  media: string[];
};

export interface Storage extends SettingsStorageDefaults {
  session_id: number;
  user_id: number;
  mtp_keyring: string;
  mtp_reset_token: string;
  pending_invitation_registration: string;
  onboarding_done: boolean;
  active_settings_profile_id: string;
  settings_profile_prompted_session_id: number;
  tauri_permissions_done: boolean;
  cached_contacts: Contacts;
  cached_communities: Communities;
  cache_contacts: number;
  cache_messages_per_chat: number;
  omega_url: string;
  forced_omikron_url: string | undefined;
  forced_omikron_public_key: string | undefined;
  call_mute_range_start: number;
  call_mute_range_end: number;
  call_microphone_device_id: string;
  call_speaker_device_id: string;
  call_noise_suppression_enabled: boolean;
  call_noise_suppression_level: number;
  call_echo_cancellation: boolean;
  call_voice_isolation: boolean;
  call_automatic_gain_control: boolean;
  call_noise_gate_enabled: boolean;
  call_event_sounds_enabled: boolean;
  call_sound_volume: number;
  call_screen_share_resolution: number;
  call_screen_share_frame_rate: number;
  call_screen_share_audio: boolean;
  call_screen_share_volume: number;
  call_screen_share_codec: "auto" | "vp8" | "vp9" | "h264" | "av1" | "h265";
  call_camera_resolution: number;
  call_camera_frame_rate: number;
  theme_color: string;
  theme_palette: Record<
    | "base00"
    | "base01"
    | "base02"
    | "base03"
    | "base04"
    | "base05"
    | "base06"
    | "base07"
    | "base08"
    | "base09"
    | "base0A"
    | "base0B"
    | "base0C"
    | "base0D"
    | "base0E"
    | "base0F",
    string
  > | null;
  theme_primary_color: string;
  theme_polarity: "dark" | "light" | "system";
  theme_tint: "soft" | "hard" | "extreme";
  theme_border_radius: number;
  theme_custom_css: string;
  theme_parent: string;
  theme_design: ThemeDesign;
  theme_selected_id: string;
  theme_custom_themes: Theme[];
  chat_trusted_domains: string[];
  chat_picker_saved_media: string[];
  chat_picker_saved_media_groups: ChatPickerMediaGroup[];
  chat_picker_last_tab: "gif" | "meme" | "saved";
  chat_picker_size: {
    width: number;
    height: number;
  } | null;
  reactions: Record<string, number>;
  hotkey_overrides: Record<string, string | null>;
}

// Each release channel talks to its own omega VM. TENSAMIN_CHANNEL is
// exposed to the client bundle by the web vite config; environments without
// it (plain tsc, vitest, node) fall back to stable.
const omegaUrls = {
  stable: "https://omega.stable.tensamin.net",
  canary: "https://omega.canary.tensamin.net",
  dev: "https://omega.dev.tensamin.net",
} as const;

const omegaEnv = (
  import.meta as ImportMeta & { env?: { TENSAMIN_CHANNEL?: string } }
).env?.TENSAMIN_CHANNEL;
const omegaChannelKey = omegaEnv ?? "";
const omegaChannel = (
  omegaChannelKey in omegaUrls ? omegaChannelKey : "stable"
) as keyof typeof omegaUrls;

export const storageDefaults: Storage = {
  session_id: 0,
  user_id: 0,
  mtp_keyring: "",
  mtp_reset_token: "",
  pending_invitation_registration: "",
  onboarding_done: false,
  active_settings_profile_id: "",
  settings_profile_prompted_session_id: 0,
  tauri_permissions_done: false,
  ...settingsStorageDefaults,
  cached_contacts: [],
  cached_communities: [],
  cache_contacts: 5,
  cache_messages_per_chat: 20,
  omega_url: omegaUrls[omegaChannel],
  forced_omikron_url: undefined,
  forced_omikron_public_key: undefined,
  call_mute_range_start: -75,
  call_mute_range_end: -65,
  call_microphone_device_id: "default",
  call_speaker_device_id: "default",
  call_noise_suppression_enabled: true,
  call_noise_suppression_level: 100,
  call_echo_cancellation: true,
  call_voice_isolation: false,
  call_automatic_gain_control: false,
  call_noise_gate_enabled: true,
  call_event_sounds_enabled: true,
  call_sound_volume: 100,
  call_screen_share_resolution: 1080,
  call_screen_share_frame_rate: 30,
  call_screen_share_audio: false,
  call_screen_share_volume: 100,
  call_screen_share_codec: "auto",
  call_camera_resolution: 1080,
  call_camera_frame_rate: 30,
  theme_color: "",
  theme_palette: null,
  theme_primary_color: "",
  theme_polarity: "system",
  theme_tint: "soft",
  theme_border_radius: 0.5,
  theme_custom_css: "",
  theme_parent: "tensamin",
  theme_design: {
    fontScale: 1,
    fontFamily: "public-sans",
    monoFontFamily: "jetbrains-mono",
  },
  theme_selected_id: "tensamin",
  theme_custom_themes: [],
  chat_trusted_domains: [
    // Other platforms
    "cdn.discordapp.com",

    // Tenor
    "tenor.com",
    "c.tenor.com",

    // Klipy
    "static.klipy.com",
    "static1.klipy.com",
    "static2.klipy.com",

    // Giphy
    "giphy.com",
    "www.giphy.com",
    "media.giphy.com",
    "i.giphy.com",
    "media0.giphy.com",
    "media1.giphy.com",
    "media2.giphy.com",
    "media3.giphy.com",
    "media4.giphy.com",
  ],
  chat_picker_saved_media: [],
  chat_picker_saved_media_groups: [],
  chat_picker_last_tab: "gif",
  chat_picker_size: null,
  reactions: {
    ":thumbsup:": 3,
    ":fire:": 2,
    ":white_check_mark:": 1,
  },
  hotkey_overrides: {},
};

// User Status
export function getStatusColor(
  status:
    | z.infer<typeof publicUserSchema.shape.OnlineStatus>
    | z.infer<typeof userPresencePreferenceSchema>,
) {
  switch (status) {
    case "user_online":
      return "#22c55e";
    case "iota_online":
      return "#22c55e";
    case "user_dnd":
      return "#ef4444";
    case "user_idle":
      return "#f59e0b";
    case "user_wc":
      return "#3b82f6";
    case "user_borked":
    case "iota_borked":
      return "#6b7280";
    case "user_offline":
    case "iota_offline":
    default:
      return "#9ca3af";
  }
}
