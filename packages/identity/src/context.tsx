import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { useMTP } from "@tensamin/mtp";

import { mtp as schemas } from "@tensamin/shared/data";
import type z from "zod";
import { createCache } from "@tensamin/cache";
import { log } from "@tensamin/shared/log";
import { useStorage } from "@tensamin/storage/context";
import { useSession } from "./session";
import { getChangedUserFields, selectUserFields } from "./selection";

export { getChangedUserFields, selectUserFields } from "./selection";

export type User = z.infer<typeof schemas.GetUserData.response>;
export type Iota = z.infer<typeof schemas.GetIotaData.response>;
type ClientUserState = User["OnlineStatus"];
export type UserField = keyof User;
export type UserFields = readonly [UserField, ...UserField[]];
export type SelectedUser<Fields extends readonly UserField[]> = Readonly<
  Pick<User, Fields[number]>
>;
export type UserProfilePatch = Omit<
  z.infer<typeof schemas.ChangeUserData.request>,
  "OnlineStatus"
>;

export function mergeTransientPresence<T extends { UserId: number }>(
  user: T,
  presence: ReadonlyMap<number, ClientUserState>,
): T {
  const state = presence.get(user.UserId);
  return state === undefined ? user : ({ ...user, OnlineStatus: state } as T);
}

const DATA_CACHE_MAX_AGE = 5 * 60 * 1000;

interface contextValue {
  get<const Fields extends UserFields>(
    userId: number,
    fields: Fields,
  ): Promise<SelectedUser<Fields>>;
  getFresh<const Fields extends UserFields>(
    userId: number,
    fields: Fields,
  ): Promise<SelectedUser<Fields>>;
  peek<const Fields extends UserFields>(
    userId: number,
    fields: Fields,
  ): SelectedUser<Fields> | undefined;
  subscribe(
    userId: number,
    fields: readonly UserField[],
    listener: () => void,
  ): () => void;
  getVersion(userId: number, fields: readonly UserField[]): string;
  getIota(userId: number): Promise<Iota>;
  getRelayIota(userId: number): Promise<Iota>;
  updateProfile(userId: number, patch: UserProfilePatch): Promise<void>;
  updateState(userId: number, state: ClientUserState): void;
}

const UserContext = createContext<contextValue | undefined>(undefined);

/**
 * Executes UserProvider.
 * @param props Parameter props.
 * @returns unknown.
 */
export default function UserProvider(props: { children: ReactNode }) {
  const storageRef = useRef<Record<number, User>>({});
  const pendingRef = useRef<Record<number, Promise<User> | undefined>>({});
  const iotaStorageRef = useRef<Record<number, Iota>>({});
  const pendingIotaRef = useRef<Record<number, Promise<Iota> | undefined>>({});
  const iotaCheckedAtRef = useRef<Record<number, number>>({});
  const profileUpdateQueuesRef = useRef(new Map<number, Promise<void>>());
  const profileGenerationsRef = useRef(new Map<number, number>());
  const checkedAtRef = useRef<Record<number, number>>({});
  const presenceRef = useRef(new Map<number, ClientUserState>());
  const durableProfileRef = useRef<Record<number, User>>({});
  const listenersRef = useRef(
    new Map<
      number,
      Set<{ fields: ReadonlySet<UserField>; listener: () => void }>
    >(),
  );
  const revisionsRef = useRef(new Map<number, Map<UserField, number>>());

  const { send, subscribe: subscribeMTP, clientState } = useMTP();
  const { load } = useStorage();
  const { contacts } = useSession();
  const [accountId, setAccountId] = useState<number | null>(null);
  const accountIdRef = useRef<number | null>(null);
  const contactsRef = useRef(contacts);
  const initialStatesRef = useRef(new Map<number, ClientUserState>());

  useEffect(() => {
    contactsRef.current = contacts;
  }, [contacts]);

  const mergeUserPresence = useCallback((user: User): User => {
    return mergeTransientPresence(user, presenceRef.current);
  }, []);

  const publishUser = useCallback((userId: number, user?: User) => {
    const previous = storageRef.current[userId];
    if (user) storageRef.current[userId] = user;
    else delete storageRef.current[userId];

    const changedFields = getChangedUserFields(previous, user);
    if (changedFields.length === 0) return;

    let revisions = revisionsRef.current.get(userId);
    if (!revisions) {
      revisions = new Map();
      revisionsRef.current.set(userId, revisions);
    }
    for (const field of changedFields) {
      revisions.set(field, (revisions.get(field) ?? 0) + 1);
    }

    const changed = new Set<UserField>(changedFields);
    for (const entry of listenersRef.current.get(userId) ?? []) {
      if ([...entry.fields].some((field) => changed.has(field))) {
        entry.listener();
      }
    }
  }, []);

  const installProfile = useCallback(
    (profile: User) => {
      durableProfileRef.current[profile.UserId] = profile;
      publishUser(profile.UserId, mergeUserPresence(profile));
    },
    [mergeUserPresence, publishUser],
  );

  const applyUserState = useCallback(
    (userId: number, state: ClientUserState, privateState = false) => {
      const currentAccountId = accountIdRef.current;
      const known =
        userId === currentAccountId ||
        durableProfileRef.current[userId] !== undefined ||
        contactsRef.current.some((contact) => contact.UserId === userId);
      if (!known) return false;

      if (state === "user_invisible" && userId !== currentAccountId)
        return false;
      if (userId === currentAccountId && !privateState) return false;
      if (presenceRef.current.get(userId) === state) return true;

      presenceRef.current.set(userId, state);
      const profile = durableProfileRef.current[userId];
      if (profile) publishUser(userId, mergeUserPresence(profile));
      return true;
    },
    [mergeUserPresence, publishUser],
  );

  const removePresence = useCallback(
    (userId: number) => {
      const removed = presenceRef.current.delete(userId);
      initialStatesRef.current.delete(userId);
      delete checkedAtRef.current[userId];
      if (!removed) return;
      const profile = durableProfileRef.current[userId];
      if (profile) publishUser(userId, profile);
    },
    [publishUser],
  );

  useEffect(() => {
    void load("user_id").then((accountId) => {
      accountIdRef.current = accountId;
      setAccountId(accountId);
    });
  }, [load]);

  const getAccountId = useCallback(async () => {
    if (accountIdRef.current !== null) return accountIdRef.current;
    const value = await load("user_id");
    accountIdRef.current = value;
    return value;
  }, [load]);

  useEffect(() => {
    if (!accountId) return;
    const unsubscribeStates = subscribeMTP("GetStates", ({ data }) => {
      for (const userId of data.MissingUserIds ?? []) removePresence(userId);
      for (const entry of data.UserStates) {
        if (!entry || entry.UserId === accountId) continue;
        initialStatesRef.current.set(entry.UserId, entry.UserState);
        if (applyUserState(entry.UserId, entry.UserState)) {
          initialStatesRef.current.delete(entry.UserId);
        }
      }
    });
    const unsubscribeChanged = subscribeMTP("ClientChanged", ({ data }) => {
      applyUserState(data.UserId, data.UserState, true);
    });
    return () => {
      unsubscribeStates();
      unsubscribeChanged();
    };
  }, [accountId, applyUserState, removePresence, subscribeMTP]);

  useEffect(() => {
    if (!accountId || !clientState?.PresenceSnapshotComplete) return;
    for (const userId of clientState.MissingUserIds) removePresence(userId);
    for (const entry of clientState.UserStates) {
      if (!entry || entry.UserId === accountId) continue;
      initialStatesRef.current.set(entry.UserId, entry.UserState);
      if (applyUserState(entry.UserId, entry.UserState)) {
        initialStatesRef.current.delete(entry.UserId);
      }
    }
  }, [accountId, applyUserState, clientState, removePresence]);

  const loadUser = useCallback(
    async (userId: number): Promise<User> => {
      if (userId == null) {
        throw new Error("userId is required");
      }

      const pendingUser = pendingRef.current[userId];
      if (pendingUser !== undefined) {
        return pendingUser;
      }

      const request = (async () => {
        const cache = createCache(String(await getAccountId()));
        const cachedValue =
          durableProfileRef.current[userId] ??
          (await cache.profiles.get(userId));
        const cachedResult =
          schemas.GetUserData.response.safeParse(cachedValue);
        const cached = cachedResult.success ? cachedResult.data : undefined;
        if (cached) {
          installProfile(cached);
          const checkedAt = checkedAtRef.current[userId];
          if (checkedAt && Date.now() - checkedAt < DATA_CACHE_MAX_AGE) {
            checkedAtRef.current[userId] = Date.now();
            return storageRef.current[userId];
          }
        }
        try {
          const profileGeneration =
            profileGenerationsRef.current.get(userId) ?? 0;
          const userData = await send("GetUserData", { UserId: userId });
          if (userData.type === "ErrorNotFound" || userData.data.UserId === 0) {
            delete durableProfileRef.current[userId];
            delete checkedAtRef.current[userId];
            publishUser(userId);
            await cache.profiles.delete(userId);
            throw new Error("GetUserData failed: user not found");
          }
          if (userData.type.startsWith("Error")) {
            throw new Error(`GetUserData failed: ${userData.type}`);
          }
          if (
            profileGeneration !==
              (profileGenerationsRef.current.get(userId) ?? 0) &&
            storageRef.current[userId]
          ) {
            return storageRef.current[userId];
          }
          const profile = schemas.GetUserData.response.parse(userData.data);
          installProfile(profile);
          checkedAtRef.current[userId] = Date.now();
          try {
            await cache.profiles.put(profile);
            log(2, "identity", "green", "Cached UserData", { userId });
          } catch (cacheError) {
            log(1, "identity", "red", "Failed to cache UserData", cacheError, {
              userId,
            });
          }
          return storageRef.current[userId];
        } catch (error) {
          if (cached && storageRef.current[userId]) {
            checkedAtRef.current[userId] = Date.now();
            return storageRef.current[userId];
          }
          throw error;
        }
      })();

      pendingRef.current[userId] = request;

      try {
        return await request;
      } finally {
        delete pendingRef.current[userId];
      }
    },
    [getAccountId, installProfile, publishUser, send],
  );

  const get = useCallback(
    async <const Fields extends UserFields>(
      userId: number,
      fields: Fields,
    ): Promise<SelectedUser<Fields>> => {
      return selectUserFields(await loadUser(userId), fields);
    },
    [loadUser],
  );

  const getFresh = useCallback(
    async <const Fields extends UserFields>(
      userId: number,
      fields: Fields,
    ): Promise<SelectedUser<Fields>> => {
      if (!Number.isSafeInteger(userId) || userId <= 0) {
        throw new Error("userId must be a positive integer");
      }
      const response = await send("GetUserData", { UserId: userId });
      if (response.type !== "GetUserData" || response.data.UserId === 0) {
        throw new Error(`GetUserData failed: ${response.type}`);
      }
      const user = schemas.GetUserData.response.parse(response.data);
      installProfile(user);
      checkedAtRef.current[userId] = Date.now();
      try {
        await createCache(String(await getAccountId())).profiles.put(user);
        log(2, "identity", "green", "Cached UserData", { userId });
      } catch (cacheError) {
        log(1, "identity", "red", "Failed to cache UserData", cacheError, {
          userId,
        });
      }
      return selectUserFields(user, fields);
    },
    [getAccountId, installProfile, send],
  );

  const getIota = useCallback(
    async (userId: number): Promise<Iota> => {
      if (userId == null) {
        throw new Error("userId is required");
      }

      const pendingIota = pendingIotaRef.current[userId];
      if (pendingIota !== undefined) {
        return pendingIota;
      }

      const request = (async () => {
        const cache = createCache(String(await getAccountId()));
        const cached =
          iotaStorageRef.current[userId] ?? (await cache.iotas.get(userId));
        if (cached) {
          iotaStorageRef.current[userId] = cached;
          const checkedAt = iotaCheckedAtRef.current[userId];
          if (checkedAt && Date.now() - checkedAt < DATA_CACHE_MAX_AGE) {
            return cached;
          }
        }

        try {
          const response = await send("GetIotaData", { UserId: userId });
          if (response.type !== "GetIotaData") {
            throw new Error(`GetIotaData failed: ${response.type}`);
          }
          const iota = schemas.GetIotaData.response.parse(response.data);
          iotaStorageRef.current[userId] = iota;
          iotaCheckedAtRef.current[userId] = Date.now();
          try {
            await cache.iotas.put(userId, iota);
            log(2, "identity", "yellow", "Cached IotaData", { userId });
          } catch (cacheError) {
            log(1, "identity", "red", "Failed to cache IotaData", cacheError, {
              userId,
            });
          }
          return iota;
        } catch (error) {
          if (cached) {
            iotaCheckedAtRef.current[userId] = Date.now();
            return cached;
          }
          throw error;
        }
      })();

      pendingIotaRef.current[userId] = request;
      try {
        return await request;
      } finally {
        delete pendingIotaRef.current[userId];
      }
    },
    [getAccountId, send],
  );

  const getRelayIota = getIota;

  const peek = useCallback(
    <const Fields extends UserFields>(userId: number, fields: Fields) => {
      const user = storageRef.current[userId];
      return user ? selectUserFields(user, fields) : undefined;
    },
    [],
  );

  const subscribe = useCallback(
    (userId: number, fields: readonly UserField[], listener: () => void) => {
      let listeners = listenersRef.current.get(userId);
      if (!listeners) {
        listeners = new Set();
        listenersRef.current.set(userId, listeners);
      }
      const entry = { fields: new Set(fields), listener };
      listeners.add(entry);
      return () => {
        listeners.delete(entry);
        if (listeners.size === 0) listenersRef.current.delete(userId);
      };
    },
    [],
  );

  const getVersion = useCallback(
    (userId: number, fields: readonly UserField[]) => {
      const revisions = revisionsRef.current.get(userId);
      return fields
        .map((field) => `${field}:${revisions?.get(field) ?? 0}`)
        .join("|");
    },
    [],
  );

  const updateProfile = useCallback(
    async (userId: number, patch: UserProfilePatch) => {
      const previousUpdate = profileUpdateQueuesRef.current.get(userId);
      const update = (
        previousUpdate?.catch(() => undefined) ?? Promise.resolve()
      ).then(async () => {
        const current = durableProfileRef.current[userId];
        if (!current) throw new Error(`User ${userId} is not loaded`);
        profileGenerationsRef.current.set(
          userId,
          (profileGenerationsRef.current.get(userId) ?? 0) + 1,
        );
        const profile = schemas.GetUserData.response.parse({
          ...current,
          ...patch,
        });
        installProfile(profile);
        checkedAtRef.current[userId] = Date.now();
        await createCache(String(await getAccountId())).profiles.put(profile);
      });
      profileUpdateQueuesRef.current.set(userId, update);
      try {
        await update;
      } finally {
        if (profileUpdateQueuesRef.current.get(userId) === update) {
          profileUpdateQueuesRef.current.delete(userId);
        }
      }
    },
    [getAccountId, installProfile],
  );

  const updateState = useCallback(
    (userId: number, state: ClientUserState) => {
      applyUserState(userId, state, true);
    },
    [applyUserState],
  );

  useEffect(() => {
    if (!accountId) return;
    void (async () => {
      const userIds = [
        accountId,
        ...contacts.map((contact) => contact.UserId),
      ].filter((userId, index, all) => all.indexOf(userId) === index);
      for (const userId of userIds) {
        try {
          await loadUser(userId);
          const state = initialStatesRef.current.get(userId);
          if (state && applyUserState(userId, state)) {
            initialStatesRef.current.delete(userId);
          }
        } catch {
          // The normal user loading path reports profile failures to its caller.
        }
      }
    })();
  }, [accountId, applyUserState, contacts, loadUser]);

  const value = useMemo(
    () => ({
      get,
      getFresh,
      getIota,
      getRelayIota,
      peek,
      subscribe,
      getVersion,
      updateProfile,
      updateState,
    }),
    [
      get,
      getFresh,
      getIota,
      getRelayIota,
      getVersion,
      peek,
      subscribe,
      updateProfile,
      updateState,
    ],
  );

  return (
    <UserContext.Provider value={value}>{props.children}</UserContext.Provider>
  );
}

/**
 * Executes useUser.
 * @param none This function has no parameters.
 * @returns contextValue.
 */
export function useUser(): contextValue {
  const context = useContext(UserContext);
  if (!context) {
    throw new Error("useUser must be used within a UserProvider");
  }
  return context;
}

export type UserLoadState<Fields extends readonly UserField[]> =
  | { data: undefined; error: undefined; loading: true }
  | { data: undefined; error: unknown; loading: false }
  | { data: SelectedUser<Fields>; error: undefined; loading: false };

export function useUserFields<const Fields extends UserFields>(
  userId: number | null,
  fields: Fields,
): UserLoadState<Fields> {
  const { get, getVersion, peek, subscribe } = useUser();
  const fieldKey = fields.join("|");
  const selectedFields = useMemo(
    () => fieldKey.split("|") as unknown as Fields,
    [fieldKey],
  );
  const requestKey = `${userId ?? "unresolved"}:${fieldKey}`;
  const [failure, setFailure] = useState<{
    error: unknown;
    requestKey: string;
  }>();

  const version = useSyncExternalStore(
    useCallback(
      (listener) =>
        userId === null
          ? () => undefined
          : subscribe(userId, selectedFields, listener),
      [selectedFields, subscribe, userId],
    ),
    useCallback(
      () =>
        userId === null ? "unresolved" : getVersion(userId, selectedFields),
      [getVersion, selectedFields, userId],
    ),
    () => "server",
  );

  useEffect(() => {
    if (userId === null) return;
    let active = true;
    void get(userId, selectedFields).catch((nextError: unknown) => {
      if (active) setFailure({ error: nextError, requestKey });
    });
    return () => {
      active = false;
    };
  }, [get, requestKey, selectedFields, userId]);

  const data = useMemo(() => {
    void version;
    return userId === null ? undefined : peek(userId, selectedFields);
  }, [peek, selectedFields, userId, version]);

  if (data) return { data, error: undefined, loading: false };
  if (failure?.requestKey === requestKey) {
    return { data: undefined, error: failure.error, loading: false };
  }
  return { data: undefined, error: undefined, loading: true };
}
