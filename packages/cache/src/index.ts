import type { z } from "zod";
import { storageDefaults } from "@tensamin/shared/data";
import {
  deleteDatabaseEntry,
  getDatabaseEntry,
  listDatabaseEntries,
  setDatabaseEntry,
} from "@tensamin/shared/indexedDb";
import {
  replaceConversation,
  selectConversationWindows,
  trimMessages,
} from "./helpers";
import {
  accountIdSchema,
  chatDraftSchema,
  contactsSchema,
  conversationWindowSchema,
  iotaDataSchema,
  userProfileSchema,
  type ChatDraft,
  type Contact,
  type ConversationWindow,
  type IotaData,
  type UserProfile,
} from "./schemas";

export * from "./helpers";
export * from "./schemas";

type CacheStore =
  "contacts" | "profiles" | "iotas" | "conversations" | "drafts";

export interface SecureValueCodec {
  encode(value: unknown): unknown | Promise<unknown>;
  decode(value: unknown): unknown | Promise<unknown>;
}

export interface CacheOptions {
  codec?: SecureValueCodec;
  contacts?: number;
  messagesPerChat?: number;
}

export interface CacheLifecycle {
  clearAccount(): Promise<void>;
  close(): Promise<void>;
}

const identityCodec: SecureValueCodec = {
  encode: (value) => value,
  decode: (value) => value,
};

export function createCache(accountId: string, options: CacheOptions = {}) {
  const account = accountIdSchema.parse(accountId);
  const codec = options.codec ?? identityCodec;
  const getLimits = async () => {
    const [storedContacts, storedMessagesPerChat] = await Promise.all([
      getDatabaseEntry("storage", "cache_contacts"),
      getDatabaseEntry("storage", "cache_messages_per_chat"),
    ]);
    return {
      contacts: Math.max(
        0,
        Math.floor(
          options.contacts ??
            (typeof storedContacts === "number"
              ? storedContacts
              : storageDefaults.cache_contacts),
        ),
      ),
      messagesPerChat: Math.max(
        0,
        Math.floor(
          options.messagesPerChat ??
            (typeof storedMessagesPerChat === "number"
              ? storedMessagesPerChat
              : storageDefaults.cache_messages_per_chat),
        ),
      ),
    };
  };
  const prefix = `${account}:`;
  const storedPrefix = (store: CacheStore) => `${store}:${prefix}`;
  const storedKey = (store: CacheStore, key: string) =>
    `${storedPrefix(store)}${key}`;
  const entries = async (store: CacheStore) => {
    const storePrefix = storedPrefix(store);
    return (await listDatabaseEntries("cache", storePrefix)).map(
      ([key, value]) => [key.slice(storePrefix.length), value] as const,
    );
  };
  let closed = false;
  const ensureOpen = () => {
    if (closed) throw new Error("Cache is closed");
  };
  const read = async <T>(
    store: CacheStore,
    key: string,
    schema: z.ZodType<T>,
  ) => {
    ensureOpen();
    const value = await getDatabaseEntry("cache", storedKey(store, key));
    return value === undefined
      ? undefined
      : schema.parse(await codec.decode(value));
  };
  const write = async <T>(
    store: CacheStore,
    key: string,
    schema: z.ZodType<T>,
    value: T,
  ) => {
    ensureOpen();
    await setDatabaseEntry(
      "cache",
      storedKey(store, key),
      await codec.encode(schema.parse(value)),
    );
  };
  const remove = async (store: CacheStore, key: string) => {
    ensureOpen();
    await deleteDatabaseEntry("cache", storedKey(store, key));
  };
  const listConversations = async () => {
    ensureOpen();
    const storedEntries = await entries("conversations");
    const windows = await Promise.all(
      storedEntries.map(async ([, value]) =>
        conversationWindowSchema.parse(await codec.decode(value)),
      ),
    );
    const { contacts } = await getLimits();
    return selectConversationWindows(windows, contacts);
  };

  return {
    contacts: {
      get: () => read("contacts", "authoritative", contactsSchema),
      replace: (contacts: Contact[]) =>
        write("contacts", "authoritative", contactsSchema, contacts),
      clear: () => remove("contacts", "authoritative"),
    },
    profiles: {
      get: (userId: number) =>
        read("profiles", String(userId), userProfileSchema),
      put: (profile: UserProfile) =>
        write("profiles", String(profile.UserId), userProfileSchema, profile),
      delete: (userId: number) => remove("profiles", String(userId)),
    },
    iotas: {
      get: (userId: number) => read("iotas", String(userId), iotaDataSchema),
      put: (userId: number, iota: IotaData) =>
        write("iotas", String(userId), iotaDataSchema, iota),
      delete: (userId: number) => remove("iotas", String(userId)),
    },
    conversations: {
      list: listConversations,
      get: (userId: string) =>
        read("conversations", userId, conversationWindowSchema),
      replace: async (window: ConversationWindow) => {
        const { contacts, messagesPerChat } = await getLimits();
        const candidate = conversationWindowSchema.parse({
          ...window,
          Messages: trimMessages(window.Messages, messagesPerChat),
        });
        const selected = selectConversationWindows(
          replaceConversation(await listConversations(), candidate),
          contacts,
        );
        await Promise.all(
          selected.map((item) =>
            write(
              "conversations",
              item.Principal,
              conversationWindowSchema,
              item,
            ),
          ),
        );
        const retained = new Set(selected.map((item) => item.Principal));
        const storedEntries = await entries("conversations");
        await Promise.all(
          storedEntries.flatMap(([key]) => {
            return retained.has(key)
              ? []
              : [deleteDatabaseEntry("cache", storedKey("conversations", key))];
          }),
        );
      },
      replaceSelected: async (windows: ConversationWindow[]) => {
        const { contacts, messagesPerChat } = await getLimits();
        const selected = selectConversationWindows(
          windows.map((window) => ({
            ...window,
            Messages: trimMessages(window.Messages, messagesPerChat),
          })),
          contacts,
        );
        await Promise.all(
          selected.map((item) =>
            write(
              "conversations",
              item.Principal,
              conversationWindowSchema,
              item,
            ),
          ),
        );
        const retained = new Set(selected.map((item) => item.Principal));
        const storedEntries = await entries("conversations");
        await Promise.all(
          storedEntries.flatMap(([key]) => {
            return retained.has(key)
              ? []
              : [deleteDatabaseEntry("cache", storedKey("conversations", key))];
          }),
        );
      },
      prune: async () => {
        const { messagesPerChat } = await getLimits();
        const windows = await listConversations();
        await Promise.all(
          windows.map((window) =>
            write("conversations", window.Principal, conversationWindowSchema, {
              ...window,
              Messages: trimMessages(window.Messages, messagesPerChat),
            }),
          ),
        );
        const retained = new Set(windows.map((window) => window.Principal));
        const storedEntries = await entries("conversations");
        await Promise.all(
          storedEntries.flatMap(([key]) =>
            retained.has(key)
              ? []
              : [deleteDatabaseEntry("cache", storedKey("conversations", key))],
          ),
        );
      },
      delete: (userId: string) => remove("conversations", userId),
    },
    drafts: {
      get: (userId: string) => read("drafts", userId, chatDraftSchema),
      put: (userId: string, draft: ChatDraft) =>
        write("drafts", userId, chatDraftSchema, draft),
      delete: (userId: string) => remove("drafts", userId),
    },
    clearAccount: async () => {
      ensureOpen();
      await Promise.all(
        (
          [
            "contacts",
            "profiles",
            "iotas",
            "conversations",
            "drafts",
          ] as CacheStore[]
        ).map(async (store) => {
          const storedEntries = await entries(store);
          await Promise.all(
            storedEntries.map(([key]) =>
              deleteDatabaseEntry("cache", storedKey(store, key)),
            ),
          );
        }),
      );
    },
    close: async () => {
      closed = true;
    },
  };
}

export type Cache = ReturnType<typeof createCache>;
