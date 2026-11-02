import { useEffect, useState } from "react";
import { type SelectedUser, type UserFields, useUserFields } from "./context";

import { failedUser } from "@tensamin/shared/data";
import { useStorage } from "@tensamin/storage/context";

// Wrapper function to pass user data to some component
export default function Wrapper<const Fields extends UserFields>(props: {
  userId: number | "own";
  fields: Fields;
  loading: React.ReactNode;
  component: (user: SelectedUser<Fields>) => React.ReactNode;
}) {
  const { load } = useStorage();
  const [ownUserId, setOwnUserId] = useState<number | null>(null);
  const [ownUserError, setOwnUserError] = useState(false);

  useEffect(() => {
    if (props.userId !== "own") return;
    let active = true;
    void load("user_id").then(
      (value) => {
        if (active) {
          setOwnUserId(value);
          setOwnUserError(false);
        }
      },
      () => {
        if (active) setOwnUserError(true);
      },
    );
    return () => {
      active = false;
    };
  }, [load, props.userId]);

  const userId = props.userId === "own" ? ownUserId : props.userId;
  const result = useUserFields(userId, props.fields);
  if (
    (props.userId === "own" && ownUserError) ||
    (!result.loading && !result.data)
  ) {
    return <>{props.component(failedUser as SelectedUser<Fields>)}</>;
  }

  return <>{result.data ? props.component(result.data) : props.loading}</>;
}
