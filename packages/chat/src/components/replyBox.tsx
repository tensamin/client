import {
  Avatar,
  AvatarFallback,
  AvatarImage,
  Button,
  cn,
  Skeleton,
} from "@nonanium/ui";
import {
  type PrincipalPresentation,
  usePrincipalPresentation,
} from "@tensamin/identity/context";
import { Forward, X } from "lucide-react";

type ReplyUserData = Pick<PrincipalPresentation, "Avatar" | "Display">;

function ReplyUser({ user }: { user: ReplyUserData }) {
  return (
    <div className="flex min-w-0 max-w-[40%] shrink-0 gap-1 items-center">
      <Avatar className="h-5 w-5 shrink-0">
        <AvatarImage src={user.Avatar} />
        <AvatarFallback className="text-[0.6rem]">
          {user.Display.slice(0, 2).toUpperCase()}
        </AvatarFallback>
      </Avatar>
      <p className="truncate text-sm font-semibold">{user.Display}</p>
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
  principal,
  variant,
}: {
  edited?: boolean;
  content?: string;
  loading?: boolean;
  onActivate?: () => void;
  onDismiss?: () => void;
  user?: ReplyUserData;
  principal?: string;
  variant: "composer" | "message";
}) {
  const resolvedUser = usePrincipalPresentation(principal);
  const presentation = user ?? resolvedUser;
  const contents = (
    <>
      {variant === "composer" && (
        <Forward className="shrink-0 opacity-60" size={18} />
      )}
      {loading ? (
        <>
          <Skeleton className="h-5 w-5 shrink-0 rounded-full" />
          <Skeleton className="h-5 w-full" />
        </>
      ) : (
        <>
          {presentation ? <ReplyUser user={presentation} /> : null}
          {content !== undefined && (
            <p
              className={cn(
                "min-w-0 flex-1 text-sm",
                variant === "message" ? "line-clamp-2" : "truncate",
              )}
              title={content}
            >
              {content}
              {edited && " (edited)"}
            </p>
          )}
        </>
      )}
      {onDismiss && (
        <Button
          className="ml-auto h-5 w-5 rounded-md! p-0!"
          onClick={onDismiss}
          aria-label="Cancel reply"
          size="xs"
          variant="ghost"
        >
          <X className="opacity-60" size={18} />
        </Button>
      )}
    </>
  );
  const className = cn(
    "flex w-full min-w-0 items-center gap-2 text-xs",
    variant === "composer"
      ? "justify-start px-3 py-2"
      : "flex-col items-start gap-1 border-l-2 border-foreground/30 pl-2 text-foreground",
  );

  return (
    <div
      className={cn(
        variant === "composer" ? "flex justify-center" : "pl-2 w-full",
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
