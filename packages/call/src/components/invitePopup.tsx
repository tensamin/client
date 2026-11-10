import {
  Avatar,
  AvatarFallback,
  AvatarImage,
  Button,
  Dialog,
  DialogContent,
  DialogTitle,
  DialogDescription,
} from "@nonanium/ui";
import Wrapper from "@tensamin/identity/wrapper";
import { PhoneIncoming, X } from "lucide-react";

export default function InvitePopup({
  open,
  onAccept,
  user,
}: {
  open: boolean;
  onAccept: (value: boolean) => void;
  user: number;
}) {
  return (
    <Wrapper
      userId={user}
      fields={["Avatar", "Display"]}
      loading={null}
      component={(user) => (
        <Dialog
          open={open}
          onOpenChange={(open) => {
            if (!open) onAccept(false);
          }}
        >
          <DialogContent
            showCloseButton={false}
            className="flex w-full max-w-sm flex-col items-center gap-5 p-6 text-center"
          >
            <DialogTitle>Incoming call</DialogTitle>
            <Avatar className="size-20">
              <AvatarImage src={user.Avatar} />
              <AvatarFallback className="text-5xl">
                {user.Display.slice(0, 2).toUpperCase()}
              </AvatarFallback>
            </Avatar>
            <DialogDescription className="max-w-full truncate text-lg font-medium text-foreground">
              {user.Display}
            </DialogDescription>
            <div className="flex w-full gap-3">
              <Button
                className="h-11! flex-1"
                variant="destructive"
                onClick={() => onAccept(false)}
              >
                <X className="size-5" />
                Decline
              </Button>
              <Button className="h-11! flex-1" onClick={() => onAccept(true)}>
                <PhoneIncoming className="size-5" />
                Accept
              </Button>
            </div>
          </DialogContent>
        </Dialog>
      )}
    />
  );
}
