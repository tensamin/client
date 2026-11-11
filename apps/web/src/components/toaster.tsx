import { Toaster, NotificationToaster, toast } from "@nonanium/ui";
import { Check, X } from "lucide-react";
import { useLayoutEffect } from "react";

export default function AppToaster() {
  useLayoutEffect(() => {
    // Feedback from a previous screen must not reappear when this screen opens.
    toast.dismiss();

    return () => {
      toast.dismiss();
    };
  }, []);

  return (
    <>
      <Toaster
        position="top-center"
        icons={{
          error: <X className="size-5 text-destructive" />,
          close: <X className="size-3 text-destructive" />,
          success: <Check className="size-5 text-primary" />,
        }}
      />
      <NotificationToaster
        position="top-center"
        icons={{
          error: <X className="size-6 text-destructive" />,
          close: <X className="size-3 text-destructive" />,
          success: <Check className="size-6 text-primary" />,
        }}
      />
    </>
  );
}
