import {
  Avatar,
  AvatarFallback,
  AvatarImage,
  Button,
  Dialog,
  DialogContent,
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
            className="flex flex-col gap-5 items-center justify-center w-65 h-80"
          >
            <Avatar className="size-30">
              <AvatarImage src={user.Avatar} />
              <AvatarFallback className="text-5xl">
                {user.Display.slice(0, 2).toUpperCase()}
              </AvatarFallback>
            </Avatar>
            <p className="text-xl font-medium">{user.Display}</p>
            <div className="w-full flex justify-center gap-3">
              <Button
                className="w-13 h-13!"
                variant="destructive"
                onClick={() => onAccept(false)}
              >
                <X className="size-5" />
              </Button>
              <Button className="w-13 h-13!" onClick={() => onAccept(true)}>
                <PhoneIncoming className="size-5" />
              </Button>
            </div>
          </DialogContent>
        </Dialog>
      )}
    />
  );
}
