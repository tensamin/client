import { useMTP } from "@tensamin/mtp";
import {
  createContext,
  type ReactNode,
  useState,
  useContext,
  useEffect,
  useCallback,
} from "react";
import { useStorage } from "@tensamin/storage/context";
import type { Contacts, Communities, Calls } from "@tensamin/shared/data";
import { createCache } from "@tensamin/cache";
import { secureValueCodec } from "@tensamin/storage/secure";

interface SessionContextType {
  contacts: Contacts;
  communities: Communities;
  calls: Calls;
  moveUserIdToTop: (userId: number) => void;
  setNotifications: (
    userId: number,
    notifications: number,
    lastMessageAt: number,
  ) => void;
  insertContact: (userId: number) => void;
  upsertCall: (call: Calls[number]) => void;
  removeCall: (callId: string) => void;
}

const SessionContext = createContext<SessionContextType | undefined>(undefined);

export default function SessionProvider({ children }: { children: ReactNode }) {
  const { freshContacts, freshCommunities, freshCalls, contextReady } =
    useMTP();
  const { load, save } = useStorage();
  const [contacts, setContacts] = useState<Contacts>([]);
  const [communities, setCommunities] = useState<Communities>([]);
  const [localCalls, setLocalCalls] = useState<Calls>([]);
  const [removedCallIds, setRemovedCallIds] = useState<string[]>([]);
  const [accountId, setAccountId] = useState<number | null>(null);
  const calls = [
    ...localCalls,
    ...freshCalls.filter(
      (call) =>
        !removedCallIds.includes(call.CallId) &&
        !localCalls.some((local) => local.CallId === call.CallId),
    ),
  ];

  useEffect(() => {
    if (!contextReady) return;
    setLocalCalls((previous) =>
      previous.filter((call) =>
        freshCalls.some((fresh) => fresh.CallId === call.CallId),
      ),
    );
  }, [contextReady, freshCalls]);

  useEffect(() => {
    setRemovedCallIds((previous) =>
      previous.filter((callId) =>
        freshCalls.some((call) => call.CallId === callId),
      ),
    );
  }, [freshCalls]);

  useEffect(() => {
    void load("user_id").then(setAccountId);
  }, [load]);

  // Cached contacts seed the session, then authenticated server data replaces them.
  useEffect(() => {
    if (!accountId || contextReady) return;
    let active = true;
    const cache = createCache(String(accountId), {
      codec: secureValueCodec,
    });
    void cache.contacts.get().then((cached) => {
      if (active && cached) setContacts(cached);
    });
    return () => {
      active = false;
    };
  }, [accountId, contextReady]);

  useEffect(() => {
    if (!accountId || !contextReady) return;
    setContacts(freshContacts);
  }, [accountId, contextReady, freshContacts]);

  useEffect(() => {
    load("cached_communities").then((cachedData) => {
      if (cachedData && freshCommunities) {
        setCommunities([
          ...freshCommunities,
          ...cachedData.filter(
            (item) =>
              !freshCommunities.some(
                (fresh) => fresh.community_id === item.community_id,
              ),
          ),
        ]);
      }
    });
  }, [load, freshCommunities]);
  useEffect(() => {
    save("cached_communities", communities);
  }, [communities, save]);

  const moveUserIdToTop = (userId: number) => {
    setContacts((prevContacts) => {
      const userIndex = prevContacts.findIndex(
        (contact) => contact.UserId === userId,
      );
      if (userIndex === -1) return prevContacts;
      const user = prevContacts[userIndex];
      return [
        user,
        ...prevContacts.slice(0, userIndex),
        ...prevContacts.slice(userIndex + 1),
      ];
    });
  };

  const setNotifications = useCallback(
    (userId: number, notifications: number, lastMessageAt: number) => {
      setContacts((previous) => {
        const contact = previous.find((item) => item.UserId === userId);
        if (!contact) {
          return [
            {
              UserId: userId,
              LastMessageAt: lastMessageAt,
              Messages: [],
              notifications,
            },
            ...previous,
          ];
        }

        const next = {
          ...contact,
          LastMessageAt: lastMessageAt,
          notifications,
        };
        return previous.map((item) => (item.UserId === userId ? next : item));
      });
    },
    [],
  );

  const insertContact = (userId: number) => {
    setContacts((prevContacts) => {
      if (prevContacts.some((contact) => contact.UserId === userId)) {
        return prevContacts;
      }

      const newUser = {
        UserId: userId,
        LastMessageAt: new Date().getTime(),
        Messages: [],
        notifications: 0,
      } satisfies Contacts[0];

      return [newUser, ...prevContacts];
    });
  };

  const upsertCall = useCallback((call: Calls[number]) => {
    setRemovedCallIds((previous) =>
      previous.filter((callId) => callId !== call.CallId),
    );
    setLocalCalls((previous) => [
      call,
      ...previous.filter((entry) => entry.CallId !== call.CallId),
    ]);
  }, []);

  const removeCall = useCallback((callId: string) => {
    setRemovedCallIds((previous) =>
      previous.includes(callId) ? previous : [...previous, callId],
    );
    setLocalCalls((previous) =>
      previous.filter((call) => call.CallId !== callId),
    );
  }, []);

  return (
    <SessionContext.Provider
      value={{
        contacts,
        communities,
        calls,
        moveUserIdToTop,
        setNotifications,
        insertContact,
        upsertCall,
        removeCall,
      }}
    >
      {children}
    </SessionContext.Provider>
  );
}

export function useSession(): SessionContextType {
  const context = useContext(SessionContext);
  if (context === undefined) {
    throw new Error("useSession must be used within a SessionProvider");
  }
  return context;
}
