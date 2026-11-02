import {
  Avatar,
  AvatarFallback,
  AvatarImage,
  Button,
  cn,
  Skeleton,
} from "@nonanium/ui";
import { Text } from "@nonanium/ui/markdown";
import type { SelectedUser } from "@tensamin/identity/context";
import Wrapper from "@tensamin/identity/wrapper";
import { Forward, X } from "lucide-react";

type ReplyUserData = SelectedUser<readonly ["Avatar", "Display"]>;

function ReplyUser({ user }: { user: ReplyUserData }) {
  return (
    <div className="flex gap-1 items-center">
      <Avatar className="h-5 w-5 shrink-0">
        <AvatarImage src={user.Avatar} />
        <AvatarFallback className="text-[0.6rem]">
          {user.Display.slice(0, 2).toUpperCase()}
        </AvatarFallback>
      </Avatar>
      <p className="text-sm font-semibold text-muted-foreground">
        {user.Display}
      </p>
    </div>
  );
}

export default function ReplyBox({
  edited,
  content,
  loading = false,
  onActivate,
  onDismiss,
  user,
  userId,
  variant,
}: {
  edited?: boolean;
  content?: string;
  loading?: boolean;
  onActivate?: () => void;
  onDismiss?: () => void;
  user?: ReplyUserData;
  userId?: number;
  variant: "composer" | "message";
}) {
  const contents = (
    <>
      <Forward className="shrink-0 opacity-60" size={18} />
      {loading ? (
        <>
          <Skeleton className="h-5 w-5 shrink-0 rounded-full" />
          <Skeleton className="h-5 w-full" />
        </>
      ) : (
        <>
          {user ? (
            <ReplyUser user={user} />
          ) : userId ? (
            <Wrapper
              userId={userId}
              fields={["Avatar", "Display"]}
              loading={<Skeleton className="h-5 w-5 rounded-full" />}
              component={(resolvedUser) => <ReplyUser user={resolvedUser} />}
            />
          ) : null}
          {content !== undefined && (
            <div className="h-5.5 min-w-0 flex-1 truncate flex gap-1">
              <Text
                fontSize="0.88rem"
                showEditedIndicator={edited}
                value={content}
              />
            </div>
          )}
        </>
      )}
      {onDismiss && (
        <Button
          className="ml-auto h-5 w-5 rounded-md! p-0!"
          onClick={onDismiss}
          size="xs"
          variant="ghost"
        >
          <X className="opacity-60" size={18} />
        </Button>
      )}
    </>
  );
  const className = cn(
    "flex w-[90%] items-center gap-1 text-xs",
    variant === "composer"
      ? "justify-start rounded-t-lg border-x border-t border-(--border)/65 bg-background p-1"
      : "text-muted-foreground",
  );

  return (
    <div
      className={cn(
        variant === "composer" ? "flex justify-center" : "pl-5 w-full",
      )}
    >
      {variant === "message" && onActivate ? (
        <button
          className={`${className} cursor-pointer text-left hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring`}
          onClick={onActivate}
          type="button"
        >
          {contents}
        </button>
      ) : (
        <div className={className}>{contents}</div>
      )}
    </div>
  );
}
