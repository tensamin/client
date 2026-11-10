import { ThemeCustomizer } from "@nonanium/ui";

export default function Page() {
  return (
    <div className="flex flex-col gap-8">
      <ThemeCustomizer />
      <a
        className="block max-w-md text-xs text-muted-foreground"
        href="https://github.com/TensaminDev/Client/issues/new"
        target="_blank"
        rel="noreferrer"
      >
        Please open an issue on Git to tell us what you would like to see in
        here.
      </a>
    </div>
  );
}
