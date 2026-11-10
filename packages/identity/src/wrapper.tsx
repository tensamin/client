import { type SelectedUser, type UserFields, useUserFields } from "./context";

import { failedUser } from "@tensamin/shared/data";
import { useMTP } from "@tensamin/mtp";

// Wrapper function to pass user data to some component
export default function Wrapper<const Fields extends UserFields>(props: {
  userId: number | "own";
  fields: Fields;
  loading: React.ReactNode;
  component: (user: SelectedUser<Fields>) => React.ReactNode;
}) {
  const { clientState } = useMTP();
  const ownUserId = clientState?.Scope?.principal.user_id ?? null;

  const userId = props.userId === "own" ? ownUserId : props.userId;
  const result = useUserFields(userId, props.fields);

  if (!result.loading && !result.data) {
    return <>{props.component(failedUser as SelectedUser<Fields>)}</>;
  }

  return <>{result.data ? props.component(result.data) : props.loading}</>;
}
