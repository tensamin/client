export type NotificationHint = {
  account: string;
  signer: string;
  relayId: string;
  kind: "MessageSend" | "FileShareOffered" | "FileShareRevoked";
  time: number;
  order?: number;
};
const listeners = new Set<(hint: NotificationHint) => void>();
export function publishNotificationHint(hint: NotificationHint) {
  for (const listener of listeners) listener(hint);
}

export function subscribeNotificationHints(
  listener: (hint: NotificationHint) => void,
) {
  listeners.add(listener);

  return () => {
    listeners.delete(listener);
  };
}
