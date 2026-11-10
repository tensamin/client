import { useMTP } from "@tensamin/mtp";
import {
  createContext,
  type ReactNode,
  useState,
  useContext,
  useEffect,
  useCallback,
} from "react";
import type { Contacts, Communities, Calls } from "@tensamin/shared/data";

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
  upsertCall: (call: Calls[number]) => void;
  removeCall: (callId: string) => void;
}

const SessionContext = createContext<SessionContextType | undefined>(undefined);

export default function SessionProvider({ children }: { children: ReactNode }) {
  const { accountKey } = useMTP();

  return (
    <AccountSessionProvider key={accountKey ?? "unverified"}>
      {children}
    </AccountSessionProvider>
  );
}

function AccountSessionProvider({ children }: { children: ReactNode }) {
  const {
    freshContacts,
    updateContacts,
    freshCommunities,
    freshCalls,
    contextReady,
    sessionEstablished,
    clientState,
  } = useMTP();
  const contacts = sessionEstablished
    ? freshContacts
    : (clientState?.Contacts ?? []);
  const communities = freshCommunities;
  const [localCalls, setLocalCalls] = useState<Calls>([]);
  const [removedCallIds, setRemovedCallIds] = useState<string[]>([]);
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

  const moveUserIdToTop = (userId: number) => {
    updateContacts((prevContacts) => {
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
      updateContacts((previous) => {
        const contact = previous.find((item) => item.UserId === userId);

        if (contact && contact.LastMessageAt > lastMessageAt) return previous;

        if (!contact) {
          return previous;
        }

        const next = {
          ...contact,
          LastMessageAt: lastMessageAt,
          notifications,
        };

        return previous.map((item) => (item.UserId === userId ? next : item));
      });
    },
    [updateContacts],
  );

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
