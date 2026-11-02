import type { User } from "@tensamin/identity/context";
import { Avatar, AvatarFallback, AvatarImage, Button } from "@nonanium/ui";
import { Text } from "@nonanium/ui/markdown";
import { ChevronDown, ChevronUp } from "lucide-react";
import { useState } from "react";

export default function Profile({
  user,
}: {
  user: Pick<
    User,
    | "UserId"
    | "Display"
    | "Username"
    | "Avatar"
    | "About"
    | "IotaId"
    | "PublicKey"
  >;
}) {
  const [showAdvancedInformation, setShowAdvancedInformation] = useState(false);

  return (
    <div className="flex flex-col gap-2">
      <div className="flex gap-2  items-center">
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
        onClick={() => setShowAdvancedInformation((show) => !show)}
      >
        {showAdvancedInformation ? (
          <ChevronUp className="size-4" />
        ) : (
          <ChevronDown className="size-4" />
        )}
        Advanced Information
      </Button>
      {showAdvancedInformation && (
        <div className="flex flex-col">
          <p className="text-muted-foreground text-xs overflow-hidden text-ellipsis whitespace-nowrap">
            Iota ID: <code>{user.IotaId}</code>
          </p>
          <p className="text-muted-foreground text-xs overflow-hidden text-ellipsis whitespace-nowrap">
            User ID: <code>{user.UserId}</code>
          </p>
          <p className="text-muted-foreground text-xs overflow-hidden text-ellipsis whitespace-nowrap">
            Public Key: <code>{user.PublicKey}</code>
          </p>
        </div>
      )}
    </div>
  );
}
