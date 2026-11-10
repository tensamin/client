import type { PrincipalPresentation } from "@tensamin/identity/context";
import { encodePrincipalForUrl } from "@tensamin/shared/principal";
import {
  Avatar,
  AvatarFallback,
  AvatarImage,
  Button,
  Tooltip,
  TooltipContent,
  TooltipTrigger,
  toast,
} from "@nonanium/ui";
import { Text } from "@nonanium/ui/markdown";
import { ChevronDown, ChevronUp, Copy } from "lucide-react";
import { useState } from "react";

function IdentityValue({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex min-w-0 items-center gap-1 text-xs text-muted-foreground">
      <dt className="shrink-0">{label}:</dt>
      <dd className="flex min-w-0 flex-1 items-center gap-1">
        <code className="min-w-0 flex-1 truncate select-text" title={value}>
          {value}
        </code>
        <Tooltip>
          <TooltipTrigger
            render={
              <Button
                variant="ghost"
                size="icon-xs"
                aria-label={`Copy ${label.toLowerCase()}`}
                onClick={() => {
                  toast.promise(navigator.clipboard.writeText(value), {
                    loading: "Copying...",
                    success: `${label} copied`,
                    error: (error: unknown) => ({
                      message: `Copying ${label.toLowerCase()} failed`,
                      description:
                        error instanceof Error ? error.message : String(error),
                    }),
                  });
                }}
              >
                <Copy />
              </Button>
            }
          />
          <TooltipContent>Copy {label.toLowerCase()}</TooltipContent>
        </Tooltip>
      </dd>
    </div>
  );
}

export default function Profile({ user }: { user: PrincipalPresentation }) {
  const [showAdvancedInformation, setShowAdvancedInformation] = useState(false);

  return (
    <div
      className="flex max-h-[70dvh] flex-col gap-2 overflow-y-auto"
      tabIndex={showAdvancedInformation ? 0 : undefined}
    >
      <div className="flex gap-2 items-center">
        <Avatar className="size-10">
          <AvatarImage src={user.Avatar} />
          <AvatarFallback className="text-lg">
            {user.Display.slice(0, 2).toUpperCase()}
          </AvatarFallback>
        </Avatar>
        <div className="flex flex-col">
          <p className="text-lg font-semibold">{user.Display}</p>
          <p className="text-muted-foreground">{user.Username}</p>
        </div>
      </div>
      <Text value={user.About || ""} />
      <Button
        className="flex justify-start"
        variant="outline"
        aria-expanded={showAdvancedInformation}
        onClick={() => setShowAdvancedInformation((show) => !show)}
      >
        {showAdvancedInformation ? (
          <ChevronUp className="size-4" />
        ) : (
          <ChevronDown className="size-4" />
        )}
        Advanced information
      </Button>
      {showAdvancedInformation && (
        <dl className="flex min-w-0 flex-col">
          {user.NodeId && (
            <IdentityValue label="Iota node" value={user.NodeId} />
          )}
          <IdentityValue
            label="Principal"
            value={encodePrincipalForUrl(user.Principal)}
          />
          {user.PublicKey && (
            <IdentityValue label="Public key" value={user.PublicKey} />
          )}
        </dl>
      )}
    </div>
  );
}
