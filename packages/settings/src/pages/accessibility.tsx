import { Button, Label, Slider } from "@nonanium/ui";
import { invoke, isTauri } from "@tauri-apps/api/core";
import { RotateCcw } from "lucide-react";
import { useEffect, useState } from "react";
import { Switch } from "../components";

const DEFAULT_INITIAL_SCALE = 290;
const MIN_INITIAL_SCALE = 210;
const isAndroid = isTauri() && /Android/.test(navigator.userAgent);

export default function Page() {
  const [initialScale, setInitialScale] = useState(DEFAULT_INITIAL_SCALE);
  const [loading, setLoading] = useState(isAndroid);

  useEffect(() => {
    if (!isAndroid) return;

    let active = true;
    void invoke<number>("accessibility_get_initial_scale")
      .then((scale) => {
        if (active) setInitialScale(scale);
      })
      .catch((error: unknown) => {
        console.error("Failed to load the Android initial scale", error);
      })
      .finally(() => {
        if (active) setLoading(false);
      });

    return () => {
      active = false;
    };
  }, []);

  function updateInitialScale(nextScale: number) {
    setInitialScale(nextScale);
    void invoke("accessibility_set_initial_scale", {
      initialScale: nextScale,
    }).catch((error: unknown) => {
      console.error("Failed to update the Android initial scale", error);
    });
  }

  return (
    <div className="flex flex-col gap-5">
      <Switch
        label="Show send button on desktop"
        id="settings.show_desktop_send_button"
      />
      {isAndroid && !loading && (
        <div className="flex max-w-md flex-col gap-2">
          <div className="flex items-center justify-between gap-2">
            <Label htmlFor="initial-scale">Interface scale</Label>
            <span className="text-muted-foreground text-sm tabular-nums">
              {initialScale}%
            </span>
          </div>
          <div className="flex items-center gap-3">
            <Slider
              id="initial-scale"
              min={MIN_INITIAL_SCALE}
              max={500}
              step={1}
              value={[initialScale]}
              disabled={loading}
              onValueChange={(value) => {
                const nextScale = Array.isArray(value) ? value[0] : value;
                if (nextScale !== undefined) updateInitialScale(nextScale);
              }}
            />
            <Button
              className="size-8 shrink-0 p-0"
              variant="outline"
              disabled={loading || initialScale === DEFAULT_INITIAL_SCALE}
              onClick={() => updateInitialScale(DEFAULT_INITIAL_SCALE)}
            >
              <RotateCcw className="size-4" />
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
