import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { base64ToBytes, ConnectionState, crypto } from "mtp";
import { createSettingsClient, type UserBlob } from "@tensamin/mtp";
import { storageDefaults, type Storage } from "@tensamin/shared/data";
import { useStorage } from "@tensamin/storage/context";
import { persistMtpCredentials } from "@tensamin/storage/credentials";
import { useMTP } from "@tensamin/mtp";
import { toast } from "@nonanium/ui";
import { Check } from "lucide-react";

const PROFILE_PREFIX = "settings-profile:";
const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();
const PROFILE_SALT = textEncoder.encode("tensamin-settings-profile-v1");
const LOADING_TOAST_ID = "settings-profile-loading";

const profileStorageKeys = (
  Object.keys(storageDefaults) as (keyof Storage)[]
).filter(
  (key) =>
    (key.startsWith("settings.") &&
      key !== "settings.call_jingle" &&
      key !== "settings.read_confirmations" &&
      key !== "settings.receive_confirmations") ||
    key.startsWith("theme_") ||
    key.startsWith("chat_picker_") ||
    [
      "cache_contacts",
      "cache_messages_per_chat",
      "chat_trusted_domains",
      "reactions",
      "hotkey_overrides",
    ].includes(key),
);

type ProfileDocument = {
  version: 2;
  id: string;
  name: string;
  lastUsedAt: number;
  themePromptCompleted: boolean;
  settings: Partial<Storage>;
  account?: {
    userId: number;
    privateKey: string;
    domain: string | null;
  };
};

export type SettingsProfile = {
  id: string;
  name: string;
  revision: number;
  available: boolean;
  document?: ProfileDocument;
};

type ProfilesContextValue = {
  profiles: SettingsProfile[];
  activeProfile: SettingsProfile | null;
  activeProfileHasTheme: boolean;
  loaded: boolean;
  loading: boolean;
  error: string;
  syncError: string;
  themePromptCompleted: boolean;
  selectProfile(id: string): Promise<void>;
  completeThemePrompt(): Promise<void>;
  createProfile(
    name: string,
    sourceId?: string,
    account?: { userId: number; privateKey: string; domain: string | null },
  ): Promise<void>;
  renameProfile(id: string, name: string): Promise<void>;
  deleteProfile(id: string): Promise<void>;
  retry(): Promise<void>;
  retrySave(): Promise<void>;
  validateName(name: string, exceptId?: string): string | null;
};

const ProfilesContext = createContext<ProfilesContextValue | undefined>(
  undefined,
);

function profileKey(keyring: string) {
  return crypto.deriveEncryptionKey(
    base64ToBytes(keyring),
    PROFILE_SALT,
    textEncoder.encode("profile-document"),
  );
}

async function decryptProfile(blob: UserBlob, keyring: string) {
  const key = profileKey(keyring);
  try {
    const parsed = JSON.parse(
      textDecoder.decode(await crypto.decrypt(key, blob.ciphertext)),
    ) as unknown;
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      ![1, 2].includes((parsed as ProfileDocument).version) ||
      (parsed as ProfileDocument).id !== blob.id.slice(PROFILE_PREFIX.length) ||
      typeof (parsed as ProfileDocument).name !== "string" ||
      typeof (parsed as ProfileDocument).settings !== "object"
    ) {
      throw new Error("Unsupported profile document");
    }
    const raw = parsed as ProfileDocument & {
      version: 1 | 2;
      lastUsedAt?: number;
      themePromptCompleted?: boolean;
    };
    if (
      raw.account !== undefined &&
      (typeof raw.account !== "object" ||
        !Number.isSafeInteger(raw.account.userId) ||
        raw.account.userId <= 0 ||
        typeof raw.account.privateKey !== "string" ||
        !raw.account.privateKey ||
        (raw.account.domain !== null && typeof raw.account.domain !== "string"))
    ) {
      throw new Error("Unsupported profile account");
    }
    const settings = Object.fromEntries(
      Object.entries(raw.settings).filter(([key, value]) => {
        if (!profileStorageKeys.includes(key as keyof Storage)) return false;
        const defaultValue = storageDefaults[key as keyof Storage];
        if (defaultValue === null)
          return value === null || typeof value === "object";
        if (Array.isArray(defaultValue)) return Array.isArray(value);
        return typeof value === typeof defaultValue;
      }),
    ) as Partial<Storage>;
    const document: ProfileDocument = {
      ...raw,
      version: 2,
      lastUsedAt:
        typeof raw.lastUsedAt === "number" ? raw.lastUsedAt : blob.updatedAt,
      themePromptCompleted: raw.themePromptCompleted === true,
      settings,
    };
    return {
      id: document.id,
      name: document.name,
      revision: blob.revision,
      available: true,
      document,
    } satisfies SettingsProfile;
  } finally {
    key.fill(0);
  }
}

async function encryptProfile(document: ProfileDocument, keyring: string) {
  const key = profileKey(keyring);
  try {
    return await crypto.encrypt(
      key,
      textEncoder.encode(JSON.stringify(document)),
    );
  } finally {
    key.fill(0);
  }
}

export function SettingsProfilesProvider({
  children,
}: {
  children: ReactNode;
}) {
  const storage = useStorage();
  const { send, subscribe, identified, clientState, readyState } = useMTP();
  const client = useMemo(
    () => createSettingsClient({ send, subscribe, clientState }),
    [clientState, send, subscribe],
  );
  const [profiles, setProfiles] = useState<SettingsProfile[]>([]);
  const profilesRef = useRef(profiles);
  const [activeId, setActiveId] = useState("");
  const activeIdRef = useRef("");
  const [loaded, setLoaded] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [syncError, setSyncError] = useState("");
  const keyringRef = useRef("");
  const applying = useRef(false);
  const saveTimer = useRef<ReturnType<typeof setTimeout> | undefined>(
    undefined,
  );
  const saveQueue = useRef(Promise.resolve());
  const loadingToastShown = useRef(false);

  useEffect(() => {
    profilesRef.current = profiles;
  }, [profiles]);
  useEffect(() => {
    activeIdRef.current = activeId;
  }, [activeId]);

  const readSettings = useCallback(async () => {
    const entries = await Promise.all(
      profileStorageKeys.map(
        async (key) => [key, await storage.load(key)] as const,
      ),
    );
    return Object.fromEntries(entries) as Partial<Storage>;
  }, [storage]);

  const persistDocument = useCallback(
    async (
      profile: SettingsProfile,
      document: ProfileDocument,
      reason: string,
    ) => {
      const ciphertext = await encryptProfile(document, keyringRef.current);
      const saved = await client.updateBlob(
        PROFILE_PREFIX + profile.id,
        ciphertext,
        profile.revision,
        { reason, value: document },
      );
      const update = (current: SettingsProfile[]) =>
        current.map((item) =>
          item.id === profile.id
            ? {
                ...item,
                document,
                name: document.name,
                revision: saved.revision,
              }
            : item,
        );
      profilesRef.current = update(profilesRef.current);
      setProfiles(update);
      setSyncError("");
    },
    [client],
  );

  const saveActive = useCallback(async () => {
    const profile = profilesRef.current.find(
      (item) => item.id === activeIdRef.current && item.available,
    );
    if (!profile?.document) return;
    const settings = await readSettings();
    try {
      await persistDocument(
        profile,
        { ...profile.document, settings },
        "settings changed",
      );
    } catch (caught) {
      setSyncError(
        caught instanceof Error
          ? caught.message
          : "Profile synchronization failed",
      );
    }
  }, [persistDocument, readSettings]);

  const flush = useCallback(async () => {
    if (saveTimer.current) {
      clearTimeout(saveTimer.current);
      saveTimer.current = undefined;
      saveQueue.current = saveQueue.current.then(saveActive);
    }
    await saveQueue.current;
  }, [saveActive]);

  useEffect(
    () =>
      storage.subscribe((keys) => {
        if (
          applying.current ||
          !activeIdRef.current ||
          !keys.some((key) => profileStorageKeys.includes(key))
        )
          return;
        if (saveTimer.current) clearTimeout(saveTimer.current);
        saveTimer.current = setTimeout(() => {
          saveTimer.current = undefined;
          saveQueue.current = saveQueue.current.then(saveActive);
        }, 300);
      }),
    [saveActive, storage],
  );

  const validateName = useCallback((name: string, exceptId?: string) => {
    const trimmed = name.trim();
    if (trimmed.length < 1 || trimmed.length > 64)
      return "Profile names must contain 1 to 64 characters.";
    if (
      profilesRef.current.some(
        (profile) =>
          profile.id !== exceptId &&
          profile.name.localeCompare(trimmed, undefined, {
            sensitivity: "accent",
          }) === 0,
      )
    )
      return "Profile names must be unique.";
    return null;
  }, []);

  const loadProfiles = useCallback(async () => {
    if (!identified) return;
    setLoading(true);
    setError("");
    try {
      const keyring = await storage.load("mtp_keyring");
      const blobs = await client.listBlobs();
      keyringRef.current = keyring;
      const relevant = blobs.filter((item) =>
        item.id.startsWith(PROFILE_PREFIX),
      );
      const decoded = await Promise.all(
        relevant.map(async (item) => {
          try {
            return await decryptProfile(
              item.ciphertext
                ? (item as UserBlob)
                : await client.getBlob(item.id),
              keyring,
            );
          } catch {
            return {
              id: item.id.slice(PROFILE_PREFIX.length),
              name: "Unavailable profile",
              revision: item.revision,
              available: false,
            } satisfies SettingsProfile;
          }
        }),
      );
      let next: SettingsProfile[] = decoded;
      if (next.length === 0) {
        const id = globalThis.crypto.randomUUID();
        const document: ProfileDocument = {
          version: 2,
          id,
          name: "Default",
          lastUsedAt: Date.now(),
          themePromptCompleted: false,
          settings: await readSettings(),
        };
        const created = await client.createBlob(
          PROFILE_PREFIX + id,
          await encryptProfile(document, keyring),
          { reason: "default profile created", value: document },
        );
        next = [
          {
            id,
            name: document.name,
            revision: created.revision,
            available: true,
            document,
          },
        ];
      }
      next.sort(
        (left, right) =>
          (right.document?.lastUsedAt ?? 0) - (left.document?.lastUsedAt ?? 0),
      );
      const selected = next.find((profile) => profile.document);
      if (!selected?.document)
        throw new Error("No settings profile is available");
      const document = { ...selected.document, lastUsedAt: Date.now() };
      applying.current = true;
      await storage.apply({
        theme_selected_id: storageDefaults.theme_selected_id,
        theme_custom_themes: storageDefaults.theme_custom_themes,
        ...document.settings,
      });
      await storage.save("active_settings_profile_id", selected.id);
      applying.current = false;
      try {
        const saved = await client.updateBlob(
          PROFILE_PREFIX + selected.id,
          await encryptProfile(document, keyring),
          selected.revision,
          { reason: "profile selected on login", value: document },
        );
        selected.document = document;
        selected.revision = saved.revision;
      } catch (caught) {
        setSyncError(
          caught instanceof Error
            ? caught.message
            : "Profile synchronization failed",
        );
      }
      profilesRef.current = next;
      setProfiles(next);
      activeIdRef.current = selected.id;
      setActiveId(selected.id);
      setLoaded(true);
    } catch (caught) {
      setError(
        caught instanceof Error ? caught.message : "Failed to load profiles",
      );
    } finally {
      applying.current = false;
      setLoading(false);
    }
  }, [client, identified, readSettings, storage]);

  useEffect(() => {
    if (
      readyState === ConnectionState.Disconnected ||
      readyState === ConnectionState.Failed
    ) {
      setLoading(false);
      if (loadingToastShown.current) {
        toast.dismiss(LOADING_TOAST_ID);
        loadingToastShown.current = false;
      }
    }
  }, [readyState]);

  useEffect(() => {
    void loadProfiles();
  }, [loadProfiles]);

  useEffect(() => {
    if (loading && loaded) {
      const timer = setTimeout(() => {
        loadingToastShown.current = true;
        toast.loading("Loading settings...", { id: LOADING_TOAST_ID });
      }, 500);
      return () => clearTimeout(timer);
    }
    if (error) {
      toast.error(error, {
        id: LOADING_TOAST_ID,
        action: { label: "Retry", onClick: () => void loadProfiles() },
      });
    } else if (
      loadingToastShown.current &&
      readyState !== ConnectionState.Disconnected &&
      readyState !== ConnectionState.Failed
    ) {
      toast.success("Settings loaded.", {
        icon: <Check className="size-4.5" />,
        id: LOADING_TOAST_ID,
      });
      loadingToastShown.current = false;
    }
  }, [error, loadProfiles, loaded, loading, readyState]);

  const selectProfile = useCallback(
    async (id: string) => {
      const profile = profilesRef.current.find(
        (item) => item.id === id && item.available,
      );
      if (!profile?.document) throw new Error("Profile is unavailable");
      await flush();
      applying.current = true;
      try {
        const document = { ...profile.document, lastUsedAt: Date.now() };
        await storage.apply({
          theme_selected_id: storageDefaults.theme_selected_id,
          theme_custom_themes: storageDefaults.theme_custom_themes,
          ...document.settings,
        });
        await storage.save("active_settings_profile_id", id);
        setActiveId(id);
        activeIdRef.current = id;
        await persistDocument(profile, document, "profile selected");
        setSyncError("");
        if (profile.document.account) {
          const [userId, keyring] = await Promise.all([
            storage.load("user_id"),
            storage.load("mtp_keyring"),
          ]);
          if (
            userId !== profile.document.account.userId ||
            keyring !== profile.document.account.privateKey
          ) {
            await persistMtpCredentials({
              storage,
              userId: profile.document.account.userId,
              keyring: profile.document.account.privateKey,
              domain: profile.document.account.domain,
            });
            globalThis.location.reload();
          }
        }
      } finally {
        applying.current = false;
      }
    },
    [flush, persistDocument, storage],
  );

  const createProfile = useCallback(
    async (
      name: string,
      sourceId?: string,
      account?: { userId: number; privateKey: string; domain: string | null },
    ) => {
      const trimmed = name.trim();
      const validation = validateName(trimmed);
      if (validation) throw new Error(validation);
      await flush();
      const source = profilesRef.current.find(
        (profile) => profile.id === sourceId,
      );
      const id = globalThis.crypto.randomUUID();
      const document: ProfileDocument = {
        version: 2,
        id,
        name: trimmed,
        lastUsedAt: Date.now(),
        themePromptCompleted: false,
        settings: source?.document?.settings ?? (await readSettings()),
        ...(account ? { account } : {}),
      };
      const created = await client.createBlob(
        PROFILE_PREFIX + id,
        await encryptProfile(document, keyringRef.current),
        { reason: "profile created", value: document },
      );
      const profile = {
        id,
        name: trimmed,
        revision: created.revision,
        available: true,
        document,
      } satisfies SettingsProfile;
      setProfiles((current) => [...current, profile]);
      profilesRef.current = [...profilesRef.current, profile];
      await selectProfile(id);
    },
    [client, flush, readSettings, selectProfile, validateName],
  );

  const renameProfile = useCallback(
    async (id: string, name: string) => {
      const profile = profilesRef.current.find((item) => item.id === id);
      const trimmed = name.trim();
      const validation = validateName(trimmed, id);
      if (validation) throw new Error(validation);
      if (!profile?.document) throw new Error("Profile is unavailable");
      await flush();
      await persistDocument(
        profile,
        { ...profile.document, name: trimmed },
        "profile renamed",
      );
    },
    [flush, persistDocument, validateName],
  );

  const completeThemePrompt = useCallback(async () => {
    const profile = profilesRef.current.find(
      (item) => item.id === activeIdRef.current,
    );
    if (!profile?.document || profile.document.themePromptCompleted) return;
    await persistDocument(
      profile,
      { ...profile.document, themePromptCompleted: true },
      "theme prompt completed",
    );
  }, [persistDocument]);

  const deleteProfile = useCallback(
    async (id: string) => {
      const profile = profilesRef.current.find((item) => item.id === id);
      if (!profile) return;
      if (profilesRef.current.length <= 1)
        throw new Error("At least one settings profile is required");
      await flush();
      await client.deleteBlob(PROFILE_PREFIX + id, profile.revision);
      const remaining = profilesRef.current.filter((item) => item.id !== id);
      setProfiles(remaining);
      profilesRef.current = remaining;
      if (id !== activeIdRef.current) return;
      const fallback = remaining
        .filter((item) => item.available)
        .sort(
          (left, right) =>
            (right.document?.lastUsedAt ?? 0) -
            (left.document?.lastUsedAt ?? 0),
        )[0];
      if (fallback) await selectProfile(fallback.id);
      else await createProfile("Default");
    },
    [client, createProfile, flush, selectProfile],
  );

  useEffect(
    () =>
      client.subscribeBlobChanges(async (event) => {
        if (!event.id.startsWith(PROFILE_PREFIX)) return;
        const id = event.id.slice(PROFILE_PREFIX.length);
        const known = profilesRef.current.find(
          (profile) => profile.id === id,
        )?.revision;
        if (known !== undefined && event.revision <= known) return;
        if (event.deleted) {
          const remaining = profilesRef.current.filter(
            (profile) => profile.id !== id,
          );
          profilesRef.current = remaining;
          setProfiles(remaining);
          if (id !== activeIdRef.current) {
            if (remaining.length === 0) await createProfile("Default");
            return;
          }
          const fallback = remaining
            .filter((profile) => profile.document)
            .sort(
              (left, right) =>
                (right.document?.lastUsedAt ?? 0) -
                (left.document?.lastUsedAt ?? 0),
            )[0];
          if (fallback) await selectProfile(fallback.id);
          else await createProfile("Default");
          return;
        }
        try {
          const remote = await decryptProfile(
            {
              id: event.id,
              ciphertext: event.ciphertext,
              revision: event.revision,
              updatedAt: event.updatedAt,
            },
            keyringRef.current,
          );
          const next = profilesRef.current.some((profile) => profile.id === id)
            ? profilesRef.current.map((profile) =>
                profile.id === id ? remote : profile,
              )
            : [...profilesRef.current, remote];
          profilesRef.current = next;
          setProfiles(next);
          if (id === activeIdRef.current && remote.document) {
            applying.current = true;
            await storage.apply({
              theme_selected_id: storageDefaults.theme_selected_id,
              theme_custom_themes: storageDefaults.theme_custom_themes,
              ...remote.document.settings,
            });
            applying.current = false;
            setSyncError("");
          }
        } catch (caught) {
          applying.current = false;
          setSyncError(
            caught instanceof Error
              ? caught.message
              : "Failed to apply the remote profile",
          );
        }
      }),
    [client, createProfile, selectProfile, storage],
  );

  useEffect(() => {
    if (!identified) return;
    void client.getReceiptPolicy().then(async (value) => {
      applying.current = true;
      await storage.apply({
        "settings.read_confirmations": value.sendReadReceipts,
        "settings.receive_confirmations": value.sendReceivedReceipts,
      });
      applying.current = false;
    });
    const unsubscribeStorage = storage.subscribe((keys) => {
      if (
        applying.current ||
        !keys.some(
          (key) =>
            key === "settings.read_confirmations" ||
            key === "settings.receive_confirmations",
        )
      )
        return;
      void Promise.all([
        storage.load("settings.read_confirmations"),
        storage.load("settings.receive_confirmations"),
      ]).then(([sendReadReceipts, sendReceivedReceipts]) => {
        return client.setReceiptPolicy({
          sendReadReceipts,
          sendReceivedReceipts,
        });
      });
    });
    const unsubscribePolicy = client.subscribeReceiptPolicy((value) => {
      applying.current = true;
      void storage
        .apply({
          "settings.read_confirmations": value.sendReadReceipts,
          "settings.receive_confirmations": value.sendReceivedReceipts,
        })
        .finally(() => {
          applying.current = false;
        });
    });
    return () => {
      unsubscribeStorage();
      unsubscribePolicy();
    };
  }, [client, identified, storage]);

  const value = useMemo<ProfilesContextValue>(
    () => ({
      profiles,
      activeProfile:
        profiles.find((profile) => profile.id === activeId) ?? null,
      activeProfileHasTheme: Boolean(
        profiles.find((profile) => profile.id === activeId)?.document?.settings
          .theme_selected_id ??
        profiles.find((profile) => profile.id === activeId)?.document?.settings
          .theme_parent,
      ),
      loaded,
      loading,
      error,
      syncError,
      themePromptCompleted:
        profiles.find((profile) => profile.id === activeId)?.document
          ?.themePromptCompleted ?? false,
      selectProfile,
      completeThemePrompt,
      createProfile,
      renameProfile,
      deleteProfile,
      retry: loadProfiles,
      retrySave: saveActive,
      validateName,
    }),
    [
      activeId,
      completeThemePrompt,
      createProfile,
      deleteProfile,
      error,
      loadProfiles,
      loaded,
      loading,
      profiles,
      renameProfile,
      saveActive,
      selectProfile,
      syncError,
      validateName,
    ],
  );

  return (
    <ProfilesContext.Provider value={value}>
      {children}
    </ProfilesContext.Provider>
  );
}

export function useSettingsProfiles() {
  const context = useContext(ProfilesContext);
  if (!context)
    throw new Error("useSettingsProfiles requires SettingsProfilesProvider");
  return context;
}
