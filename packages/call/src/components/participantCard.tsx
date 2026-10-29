import { Avatar, AvatarFallback, AvatarImage, cn } from "@nonanium/ui";
import { useUserFields } from "@tensamin/identity/context";
import { useEffect, useState, type ReactNode } from "react";

export function getAverageImageColor(src: string) {
  return new Promise<string | undefined>((resolve) => {
    const image = new Image();

    image.crossOrigin = "anonymous";
    image.referrerPolicy = "no-referrer";
    image.onload = () => {
      const canvas = document.createElement("canvas");
      const context = canvas.getContext("2d", { willReadFrequently: true });

      if (!context) {
        resolve(undefined);
        return;
      }

      canvas.width = 32;
      canvas.height = 32;
      context.drawImage(image, 0, 0, canvas.width, canvas.height);

      try {
        const { data } = context.getImageData(
          0,
          0,
          canvas.width,
          canvas.height,
        );
        let red = 0;
        let green = 0;
        let blue = 0;
        let total = 0;

        for (let index = 0; index < data.length; index += 4) {
          const alpha = data[index + 3];

          if (alpha < 128) continue;

          red += data[index] * alpha;
          green += data[index + 1] * alpha;
          blue += data[index + 2] * alpha;
          total += alpha;
        }

        if (total === 0) {
          resolve(undefined);
          return;
        }

        const darken = 0.7;
        resolve(
          `rgb(${Math.round((red / total) * darken)}, ${Math.round((green / total) * darken)}, ${Math.round((blue / total) * darken)})`,
        );
      } catch {
        resolve(undefined);
      }
    };
    image.onerror = () => resolve(undefined);
    image.src = src;
  });
}

export function ParticipantCardAvatar({
  user,
}: {
  user: { Avatar?: string; Display: string };
}) {
  return (
    <Avatar style={{ width: "32cqh", height: "32cqh" }}>
      <AvatarImage src={user.Avatar} />
      <AvatarFallback style={{ fontSize: "11cqh" }}>
        {user.Display.slice(0, 2).toUpperCase()}
      </AvatarFallback>
    </Avatar>
  );
}

export default function ParticipantCard({
  user,
  children,
  fill = false,
  flush = false,
}: {
  user?: { Avatar?: string; Display: string };
  children?: ReactNode;
  fill?: boolean;
  flush?: boolean;
}) {
  const [avatarBackgroundColor, setAvatarBackgroundColor] = useState<string>();

  useEffect(() => {
    if (!user?.Avatar) {
      setAvatarBackgroundColor(undefined);
      return;
    }
    let active = true;
    void getAverageImageColor(user.Avatar).then((color) => {
      if (active) setAvatarBackgroundColor(color);
    });
    return () => {
      active = false;
    };
  }, [user?.Avatar]);

  return (
    <div
      className={cn(
        "absolute inset-0 z-10 flex items-center justify-center gap-2 border-(--border)/40 bg-card transition-all duration-150",
        flush
          ? fill
            ? "rounded-none"
            : "rounded-none border-y"
          : "rounded-lg border",
      )}
      style={{
        backgroundColor: user?.Avatar ? avatarBackgroundColor : undefined,
        containerType: "size",
      }}
    >
      {children}
    </div>
  );
}

export function ParticipantNameplate({ name }: { name: string }) {
  return (
    <div className="flex h-6 items-center justify-center rounded-sm border border-white/15 bg-black/55 px-1.5 text-white">
      <p className="truncate text-sm">{name}</p>
    </div>
  );
}

export function PreviewParticipant({ userId }: { userId: number }) {
  const { data: user } = useUserFields(userId, ["UserId", "Display", "Avatar"]);
  return user ? (
    <div className="relative aspect-video w-full">
      <ParticipantCard user={user}>
        <ParticipantCardAvatar user={user} />
      </ParticipantCard>
      <div className="absolute bottom-0 left-0 z-20 flex h-full w-full items-end p-2">
        <div
          className="flex w-fit max-w-full items-center gap-1 rounded-sm backdrop-blur-md"
          style={{
            viewTransitionName: `call-overlay-user-${userId}`,
            viewTransitionClass: "call-overlay",
          }}
        >
          <ParticipantNameplate name={user.Display} />
        </div>
      </div>
    </div>
  ) : null;
}
