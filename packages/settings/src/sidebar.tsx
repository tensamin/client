import { Button, cn } from "@nonanium/ui";
import { useLocation, useNavigate } from "@tanstack/react-router";

import { settingsNavigation } from "./navigation";

export function SettingsSidebar({
  mobile = false,
  className,
}: {
  mobile?: boolean;
  className?: string;
}) {
  const navigate = useNavigate();
  const { pathname } = useLocation();
  const categories = [
    ...new Set(settingsNavigation.map((page) => page.category)),
  ];

  return (
    <div
      className={cn(
        mobile
          ? "w-full p-1"
          : "h-full min-h-0 w-auto shrink-0 overflow-y-auto rounded-tl-2xl bg-input/15 p-3",
        "flex flex-col gap-6",
        className,
      )}
    >
      {categories.map((category) => (
        <div key={category ?? "uncategorized"} className="flex flex-col gap-2">
          {category && (
            <h2 className="font-medium text-sm">
              {category.at(0)?.toUpperCase() + category.slice(1)}
            </h2>
          )}
          {settingsNavigation
            .filter((page) => page.category === category)
            .map((page) => (
              <Button
                key={page.path}
                className="w-full flex justify-start"
                variant="ghost"
                aria-current={
                  pathname === `/settings/${page.path}` ? "page" : undefined
                }
                onClick={() => navigate({ to: `/settings/${page.path}` })}
              >
                {page.icon}
                {page.label}
              </Button>
            ))}
        </div>
      ))}
    </div>
  );
}
