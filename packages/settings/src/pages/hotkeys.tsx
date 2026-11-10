import {
  Button,
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
  Kbd,
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@nonanium/ui";
import {
  formatForDisplay,
  useHotkeyDefinitions,
  useHotkeyRecorder,
  useHotkeysContext,
  type HotkeyDefinition,
} from "@tensamin/hotkeys";
import { AlertTriangle, Edit, Info, Trash, Undo2 } from "lucide-react";
import { useEffect, useState } from "react";

function HotkeyRow({
  definition,
  conflicts,
  isRecording,
  startRecording,
  stopRecording,
}: {
  definition: HotkeyDefinition;
  conflicts: string[];
  isRecording: boolean;
  startRecording: () => void;
  stopRecording: () => void;
}) {
  const { bindingFor, setBinding, resetBinding, globalStatuses } =
    useHotkeysContext();
  const binding = bindingFor(definition);

  return (
    <div className="flex gap-1 items-center justify-between">
      <div className="flex gap-2 items-center">
        {definition.description && (
          <Tooltip>
            <TooltipTrigger render={<Info className="size-3.75" />} />
            <TooltipContent className="flex-col items-start gap-0!">
              {definition.description && (
                <>
                  <p className="font-semibold">Description</p>
                  {definition.description}
                </>
              )}

              <>
                <p className="font-semibold pt-3">Scope</p>
                {definition.global
                  ? "Active, even if the app is closed."
                  : "Only active while the window is focused."}
              </>
            </TooltipContent>
          </Tooltip>
        )}
        <p className="font-medium text-sm">{definition.name}</p>
        <Kbd>{binding ? formatForDisplay(binding) : "Unbound"}</Kbd>
      </div>
      <div className="mr-auto">
        {conflicts.length > 0 && (
          <Tooltip>
            <TooltipTrigger
              render={
                <AlertTriangle className="size-4 text-amber-600 dark:text-amber-400" />
              }
            />
            <TooltipContent>
              Also assigned to "{conflicts.join(", ")}".
            </TooltipContent>
          </Tooltip>
        )}
        {definition.global &&
          globalStatuses[definition.id] === "unavailable" && (
            <Tooltip>
              <TooltipTrigger
                render={<AlertTriangle className="size-4 text-destructive" />}
              />
              <TooltipContent>
                Failed to register a global shortcut. It may be reserved by the
                operating system or another application.
              </TooltipContent>
            </Tooltip>
          )}
      </div>
      <div className="flex items-center">
        <Dialog>
          <DialogTrigger
            render={({ onClick }) => (
              <Button onClick={onClick} variant="outline" size="sm">
                <Edit />
              </Button>
            )}
          />
          <DialogContent>
            <DialogHeader>
              <DialogTitle>Update Hotkey</DialogTitle>
            </DialogHeader>
            <div className="flex gap-2">
              Current Shotcut:
              <Kbd>{binding ? formatForDisplay(binding) : "Unbound"}</Kbd>
            </div>
            {conflicts.length > 0 && (
              <p className="text-sm text-amber-600 dark:text-amber-400">
                Also assigned to "{conflicts.join(", ")}".
              </p>
            )}
            {definition.global &&
              globalStatuses[definition.id] === "unavailable" && (
                <p className="text-sm text-destructive">
                  Electron could not register this shortcut. It may be reserved
                  by the operating system or another application.
                </p>
              )}
            <DialogFooter>
              <div className="flex flex-wrap gap-2">
                <Button
                  variant="outline"
                  onClick={isRecording ? stopRecording : startRecording}
                >
                  {isRecording ? "Press any key to bind..." : "Record"}
                </Button>
                <Button
                  variant="outline"
                  disabled={binding === null}
                  onClick={() => setBinding(definition, null)}
                >
                  <Trash
                    className="size-4"
                    stroke={binding === null ? "gray" : "white"}
                  />
                </Button>
                <Button
                  variant="outline"
                  disabled={binding === definition.defaultBinding}
                  onClick={() => resetBinding(definition)}
                >
                  <Undo2
                    className="size-4"
                    stroke={
                      binding === definition.defaultBinding ? "gray" : "white"
                    }
                  />
                </Button>
              </div>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </div>
    </div>
  );
}

export default function Page() {
  const definitions = useHotkeyDefinitions();
  const { bindingFor, resetAll, setBinding, setRecording } =
    useHotkeysContext();
  const [recordingId, setRecordingId] = useState<string | null>(null);
  const categories = [...new Set(definitions.map(({ category }) => category))];
  const recorder = useHotkeyRecorder({
    ignoreInputs: false,
    onRecord: (hotkey) => {
      const definition = definitions.find(({ id }) => id === recordingId);

      if (definition) setBinding(definition, hotkey || null);
      setRecordingId(null);
      setRecording(false);
    },
    onCancel: () => {
      setRecordingId(null);
      setRecording(false);
    },
  });

  useEffect(() => () => setRecording(false), [setRecording]);

  return (
    <div className="flex max-w-3xl flex-col gap-6">
      {categories.map((category) => (
        <section className="flex flex-col gap-3" key={category}>
          <h2 className="text-lg font-semibold">{category}</h2>
          {definitions
            .filter((definition) => definition.category === category)
            .map((definition) => {
              const binding = bindingFor(definition);
              const conflicts = binding
                ? definitions
                    .filter(
                      (candidate) =>
                        candidate.id !== definition.id &&
                        bindingFor(candidate) === binding,
                    )
                    .map(({ name }) => name)
                : [];

              return (
                <HotkeyRow
                  conflicts={conflicts}
                  definition={definition}
                  isRecording={
                    recordingId === definition.id && recorder.isRecording
                  }
                  key={definition.id}
                  startRecording={() => {
                    setRecordingId(definition.id);
                    setRecording(true);
                    recorder.startRecording();
                  }}
                  stopRecording={() => {
                    setRecordingId(null);
                    setRecording(false);
                    recorder.stopRecording();
                  }}
                />
              );
            })}
        </section>
      ))}
      {definitions.length === 0 && (
        <p className="text-sm text-muted-foreground">
          No configurable hotkeys are registered.
        </p>
      )}
      <div className="flex items-center justify-between gap-4">
        <Button variant="outline" onClick={resetAll}>
          Reset All
        </Button>
      </div>
    </div>
  );
}
