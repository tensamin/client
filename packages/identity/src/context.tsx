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
import { bytesToBase64 } from "mtp";
import type { verifyPrincipalProof } from "@tensamin/crypto/principalProof";

import { mtp as schemas, presenceSnapshotSchema } from "@tensamin/shared/data";
import type z from "zod";
import { createCache } from "@tensamin/cache";
import { log } from "@tensamin/shared/log";
import { secureValueCodec } from "@tensamin/storage/secure";
import {
  encodePrincipal,
  parsePrincipal,
  parseWirePrincipal,
} from "@tensamin/shared/principal";
import { createPrincipalProofResolver } from "@tensamin/mtp/principalProof";
import { useSession } from "./session";
import { getChangedUserFields, selectUserFields } from "./selection";
import { PresenceOrder } from "./presence";

export { getChangedUserFields, selectUserFields } from "./selection";

export type User = z.infer<typeof schemas.GetUserData.response>;
export type PrincipalPresentation = Pick<User, "Display" | "Avatar"> &
  Partial<Pick<User, "Username" | "About" | "PublicKey">> & {
    Principal: string;
    NodeId?: string;
    DescriptorRevision?: string;
    DescriptorValidUntil?: string;
  };
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
  getPrincipal(
    principal: string,
  ): Promise<ReturnType<typeof verifyPrincipalProof>>;
  getPresentation(principal: string): Promise<PrincipalPresentation>;
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
  const { accountKey } = useMTP();
  return <AccountUserProvider key={accountKey ?? "unverified"} {...props} />;
}

function AccountUserProvider(props: { children: ReactNode }) {
  const activeRef = useRef(true);
  const storageRef = useRef<Record<number, User>>({});
  const pendingRef = useRef<Record<number, Promise<User> | undefined>>({});
  const iotaStorageRef = useRef<Record<number, Iota>>({});
  const pendingIotaRef = useRef<Record<number, Promise<Iota> | undefined>>({});
  const iotaCheckedAtRef = useRef<Record<number, number>>({});
  const profileUpdateQueuesRef = useRef(new Map<number, Promise<void>>());
  const profileGenerationsRef = useRef(new Map<number, number>());
  const checkedAtRef = useRef<Record<number, number>>({});
  const presenceRef = useRef(new Map<number, ClientUserState>());
  const presenceOrder = useRef(new PresenceOrder<ClientUserState>());
  const durableProfileRef = useRef<Record<number, User>>({});
  const listenersRef = useRef(
    new Map<
      number,
      Set<{ fields: ReadonlySet<UserField>; listener: () => void }>
    >(),
  );
  const revisionsRef = useRef(new Map<number, Map<UserField, number>>());

  const {
    send,
    subscribe: subscribeMTP,
    clientState,
    accountKey,
    client,
  } = useMTP();
  const principalResolver = useRef<
    ReturnType<typeof createPrincipalProofResolver> | undefined
  >(undefined);
  useEffect(() => {
    activeRef.current = true;
    const controller = new AbortController();
    principalResolver.current = accountKey
      ? createPrincipalProofResolver({
          accountKey,
          send,
          signal: controller.signal,
        })
      : undefined;
    return () => {
      activeRef.current = false;
      controller.abort();
    };
  }, [accountKey, send]);
  const getPrincipal = useCallback((canonical: string) => {
    if (!principalResolver.current)
      throw new Error("Verified account identity is unavailable");
    return principalResolver.current(parseWirePrincipal(canonical));
  }, []);
  const authority = clientState?.Scope?.principal.authority;
  const cacheFor = useCallback(
    (userId: number) => {
      if (!accountKey || !authority)
        throw new Error("Verified account identity is unavailable");
      return {
        cache: createCache(accountKey, { codec: secureValueCodec }),
        principal: encodePrincipal({ authority, user_id: userId }),
      };
    },
    [accountKey, authority],
  );
  const { contacts } = useSession();
  const accountId = clientState?.Scope?.principal.user_id ?? null;
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
      const initial = initialStatesRef.current.get(profile.UserId);
      if (initial !== undefined) {
        presenceRef.current.set(profile.UserId, initial);
        initialStatesRef.current.delete(profile.UserId);
      }
      publishUser(profile.UserId, mergeUserPresence(profile));
    },
    [mergeUserPresence, publishUser],
  );

  const applyUserState = useCallback(
    (userId: number, state: ClientUserState, privateState = false) => {
      const currentAccountId = accountId;
      const isContact = contactsRef.current.some(
        (contact) => contact.UserId === userId,
      );
      const known =
        userId === currentAccountId ||
        durableProfileRef.current[userId] !== undefined ||
        isContact;
      if (!known) return false;

      if (state === "user_invisible" && userId !== currentAccountId)
        return false;
      if (userId === currentAccountId && !privateState && !isContact)
        return false;
      if (presenceRef.current.get(userId) === state) return true;

      presenceRef.current.set(userId, state);
      const profile = durableProfileRef.current[userId];
      if (profile) publishUser(userId, mergeUserPresence(profile));
      return true;
    },
    [accountId, mergeUserPresence, publishUser],
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

  const applyPresenceSnapshot = useCallback(
    (snapshot: z.infer<typeof presenceSnapshotSchema>) => {
      const replaced = presenceOrder.current.install(
        snapshot.Uuid,
        snapshot.Timestamp,
      );
      if (replaced === null) return;
      if (replaced) {
        for (const userId of [...presenceRef.current.keys()])
          removePresence(userId);
        initialStatesRef.current.clear();
      }
      for (const userId of snapshot.MissingUserIds) {
        if (
          presenceOrder.current.accept(
            snapshot.Uuid,
            snapshot.Timestamp,
            userId,
            snapshot.VersionNumber,
          )
        ) {
          removePresence(userId);
          initialStatesRef.current.set(userId, "user_borked");
          if (applyUserState(userId, "user_borked"))
            initialStatesRef.current.delete(userId);
        }
      }
      for (const entry of snapshot.UserStates) {
        if (
          presenceOrder.current.accept(
            snapshot.Uuid,
            snapshot.Timestamp,
            entry.UserId,
            entry.VersionNumber,
          )
        ) {
          initialStatesRef.current.set(entry.UserId, entry.UserState);
          if (applyUserState(entry.UserId, entry.UserState)) {
            initialStatesRef.current.delete(entry.UserId);
          }
        }
      }
      for (const { userId, state } of presenceOrder.current.takePending()) {
        initialStatesRef.current.set(userId, state);
        if (applyUserState(userId, state))
          initialStatesRef.current.delete(userId);
      }
    },
    [applyUserState, removePresence],
  );

  useEffect(() => {
    presenceOrder.current = new PresenceOrder<ClientUserState>();
    for (const userId of [...presenceRef.current.keys()])
      removePresence(userId);
    initialStatesRef.current.clear();
  }, [client, removePresence]);

  useEffect(() => {
    if (!accountId || !client) return;
    const unsubscribeStates = subscribeMTP("GetStates", ({ data }) => {
      const snapshot = presenceSnapshotSchema.safeParse(data);
      if (snapshot.success) applyPresenceSnapshot(snapshot.data);
    });
    const unsubscribeChanged = subscribeMTP("ClientChanged", ({ data }) => {
      if (
        data.Uuid &&
        data.Timestamp !== undefined &&
        data.VersionNumber !== undefined &&
        contactsRef.current.some((contact) => contact.UserId === data.UserId) &&
        presenceOrder.current.event(
          data.Uuid,
          data.Timestamp,
          data.UserId,
          data.VersionNumber,
          data.UserState,
        )
      ) {
        initialStatesRef.current.set(data.UserId, data.UserState);
        if (applyUserState(data.UserId, data.UserState))
          initialStatesRef.current.delete(data.UserId);
      }
    });
    return () => {
      unsubscribeStates();
      unsubscribeChanged();
    };
  }, [accountId, applyUserState, applyPresenceSnapshot, subscribeMTP, client]);

  useEffect(() => {
    if (accountId && client && clientState?.presenceSnapshot)
      applyPresenceSnapshot(clientState.presenceSnapshot);
    else if (clientState?.callsAndCommunitiesLoaded) {
      initialStatesRef.current.clear();
      for (const { UserId: userId } of contactsRef.current) {
        removePresence(userId);
        initialStatesRef.current.set(userId, "user_borked");
        applyUserState(userId, "user_borked");
      }
    }
  }, [
    accountId,
    applyPresenceSnapshot,
    clientState,
    client,
    removePresence,
    applyUserState,
  ]);

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
        const { cache, principal } = cacheFor(userId);
        const cachedValue =
          durableProfileRef.current[userId] ??
          (await cache.profiles.get(principal));
        if (!activeRef.current) throw new Error("Account identity changed");
        const cachedResult =
          schemas.GetUserData.response.safeParse(cachedValue);
        const cached = cachedResult.success ? cachedResult.data : undefined;
        if (cached) {
          installProfile(cached);
          const checkedAt = checkedAtRef.current[userId];
          if (checkedAt && Date.now() - checkedAt < DATA_CACHE_MAX_AGE) {
            return storageRef.current[userId];
          }
        }
        try {
          const profileGeneration =
            profileGenerationsRef.current.get(userId) ?? 0;
          const userData = await send("GetUserData", { UserId: userId });
          if (!activeRef.current) throw new Error("Account identity changed");
          if (userData.type === "ErrorNotFound" || userData.data.UserId === 0) {
            delete durableProfileRef.current[userId];
            delete checkedAtRef.current[userId];
            publishUser(userId);
            await cache.profiles.delete(principal);
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
          if (profile.UserId !== userId)
            throw new Error("Profile identity mismatch");
          installProfile(profile);
          checkedAtRef.current[userId] = Date.now();
          try {
            await cache.profiles.put(principal, profile);
            log(2, "identity", "green", "Cached UserData", { userId });
          } catch (cacheError) {
            log(1, "identity", "red", "Failed to cache UserData", cacheError, {
              userId,
            });
          }
          return storageRef.current[userId];
        } catch (error) {
          if (activeRef.current && cached && storageRef.current[userId]) {
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
    [cacheFor, installProfile, publishUser, send],
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
      if (!activeRef.current) throw new Error("Account identity changed");
      if (response.type !== "GetUserData" || response.data.UserId !== userId) {
        throw new Error(`GetUserData failed: ${response.type}`);
      }
      const user = schemas.GetUserData.response.parse(response.data);
      installProfile(user);
      checkedAtRef.current[userId] = Date.now();
      try {
        const { cache, principal } = cacheFor(userId);
        await cache.profiles.put(principal, user);
        log(2, "identity", "green", "Cached UserData", { userId });
      } catch (cacheError) {
        log(1, "identity", "red", "Failed to cache UserData", cacheError, {
          userId,
        });
      }
      return selectUserFields(user, fields);
    },
    [cacheFor, installProfile, send],
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
        const { cache, principal } = cacheFor(userId);
        const cached =
          iotaStorageRef.current[userId] ?? (await cache.iotas.get(principal));
        if (!activeRef.current) throw new Error("Account identity changed");
        if (cached) {
          iotaStorageRef.current[userId] = cached;
          const checkedAt = iotaCheckedAtRef.current[userId];
          if (checkedAt && Date.now() - checkedAt < DATA_CACHE_MAX_AGE) {
            return cached;
          }
        }

        try {
          const response = await send("GetIotaData", { UserId: userId });
          if (!activeRef.current) throw new Error("Account identity changed");
          if (response.type !== "GetIotaData") {
            throw new Error(`GetIotaData failed: ${response.type}`);
          }
          const iota = schemas.GetIotaData.response.parse(response.data);
          iotaStorageRef.current[userId] = iota;
          iotaCheckedAtRef.current[userId] = Date.now();
          try {
            await cache.iotas.put(principal, iota);
            log(2, "identity", "yellow", "Cached IotaData", { userId });
          } catch (cacheError) {
            log(1, "identity", "red", "Failed to cache IotaData", cacheError, {
              userId,
            });
          }
          return iota;
        } catch (error) {
          if (activeRef.current && cached) {
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
    [cacheFor, send],
  );

  const getRelayIota = getIota;

  const presentationRequests = useRef(
    new Map<string, Promise<PrincipalPresentation>>(),
  );
  const presentationValues = useRef(
    new Map<string, PrincipalPresentation & { verifiedAt: number }>(),
  );
  const getPresentation = useCallback(
    (canonical: string): Promise<PrincipalPresentation> => {
      const principal = parsePrincipal(canonical);
      const pending = presentationRequests.current.get(canonical);
      if (pending) return pending;
      const request = (async () => {
        if (!accountKey)
          throw new Error("Verified account identity is unavailable");
        const cache = createCache(accountKey, { codec: secureValueCodec });
        const cached =
          presentationValues.current.get(canonical) ??
          (await cache.presentations.get(canonical));
        if (!activeRef.current) throw new Error("Account identity changed");
        if (
          cached &&
          cached.Principal === canonical &&
          cached.DescriptorRevision &&
          (!cached.DescriptorValidUntil ||
            BigInt(cached.DescriptorValidUntil) > BigInt(Date.now())) &&
          cached.verifiedAt <= Date.now() &&
          Date.now() - cached.verifiedAt < DATA_CACHE_MAX_AGE
        )
          return cached;
        const verified = await getPrincipal(canonical);
        if (!activeRef.current) throw new Error("Account identity changed");
        const signingKeys = verified.publicKeys.map(bytesToBase64);
        // Full Omega profiles are meaningful only in that Omega's own namespace.
        const profile =
          principal.authority === authority &&
          authority.startsWith("omega-key:")
            ? await getFresh(principal.user_id, [
                "Display",
                "Avatar",
                "PublicKey",
                "About",
              ])
            : undefined;
        if (!activeRef.current) throw new Error("Account identity changed");
        if (profile && !signingKeys.includes(profile.PublicKey)) {
          throw new Error("Profile key does not match verified principal");
        }
        const value = {
          Principal: canonical,
          Display:
            profile?.Display ??
            verified.displayName ??
            verified.username ??
            canonical,
          Avatar: profile?.Avatar,
          Username: verified.username ?? undefined,
          About: profile?.About,
          PublicKey: signingKeys[0],
          NodeId: verified.home,
          DescriptorRevision: verified.revision.toString(),
          DescriptorValidUntil: verified.validUntil?.toString(),
          verifiedAt: Date.now(),
        };
        await cache.presentations.put(value);
        if (!activeRef.current) throw new Error("Account identity changed");
        presentationValues.current.set(canonical, value);
        return value;
      })().finally(() => presentationRequests.current.delete(canonical));
      presentationRequests.current.set(canonical, request);
      return request;
    },
    [accountKey, authority, getFresh, getPrincipal],
  );

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
        const { cache, principal } = cacheFor(userId);
        await cache.profiles.put(principal, profile);
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
    [cacheFor, installProfile],
  );

  const updateState = useCallback(
    (userId: number, state: ClientUserState) => {
      applyUserState(userId, state, true);
    },
    [applyUserState],
  );

  useEffect(() => {
    if (!accountId) return;
    void loadUser(accountId).catch((error) => {
      log(1, "identity", "yellow", "Own profile unavailable", error);
    });
  }, [accountId, loadUser]);

  const value = useMemo(
    () => ({
      get,
      getPrincipal,
      getPresentation,
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
      getPrincipal,
      getPresentation,
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

export function usePrincipalPresentation(principal: string | undefined) {
  const { getPresentation } = useUser();
  const { accountKey } = useMTP();
  const [result, setResult] = useState<{
    principal: string;
    accountKey: string;
    data: PrincipalPresentation;
  }>();
  useEffect(() => {
    if (!principal || !accountKey) return;
    let active = true;
    void getPresentation(principal)
      .then((data) => {
        if (active) setResult({ principal, accountKey, data });
      })
      .catch((error) => {
        if (active)
          log(1, "identity", "yellow", "Presentation unavailable", error);
      });
    return () => {
      active = false;
    };
  }, [accountKey, getPresentation, principal]);
  return result &&
    result.principal === principal &&
    result.accountKey === accountKey
    ? result.data
    : principal
      ? { Principal: principal, Display: principal }
      : undefined;
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
