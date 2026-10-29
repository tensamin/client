import {
  Button,
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
  Label,
  LabeledSwitch,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Slider,
} from "@nonanium/ui";
import {
  canSwitchAudioOutput,
  getCallDevices,
  getSupportedCallScreenShareCodecs,
  switchCallDevice,
  useCall,
} from "@tensamin/call/store";
import { storageDefaults, type Storage } from "@tensamin/shared/data";
import { toast } from "@tensamin/shared/log";
import { playSound, stopSound } from "@tensamin/shared/sounds";
import { useStorage } from "@tensamin/storage/context";
import { ChevronDown, Play, Square } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";

type CallCodec = Storage["call_screen_share_codec"];
type DeviceOption = { id: string; label: string };

const jingleLabels: Record<Storage["settings.call_jingle"], string> = {
  jingle_1: "Jingle 1",
  jingle_2: "Jingle 2",
};
const codecLabels: Record<CallCodec, string> = {
  auto: "Automatic",
  vp8: "VP8",
  vp9: "VP9",
  h264: "H.264",
  av1: "AV1",
  h265: "H.265",
};
const callPageKeys = [
  "call_microphone_device_id",
  "call_speaker_device_id",
  "call_noise_suppression_enabled",
  "call_noise_suppression_level",
  "call_echo_cancellation",
  "call_voice_isolation",
  "call_automatic_gain_control",
  "call_noise_gate_enabled",
  "call_event_sounds_enabled",
  "call_sound_volume",
  "call_mute_range_start",
  "call_screen_share_codec",
  "settings.call_jingle",
] as const satisfies readonly (keyof Storage)[];
type PageValues = Pick<Storage, (typeof callPageKeys)[number]>;

function sliderValue(value: number | readonly number[], fallback: number) {
  return typeof value === "number" ? value : (value[0] ?? fallback);
}

import { Tooltip, TooltipContent, TooltipTrigger } from "@nonanium/ui";
import { AlertTriangle } from "lucide-react";

function WarningIndicator({ warnings }: { warnings: string[] }) {
  if (warnings.length === 0) return null;

  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <AlertTriangle
            fill="orange"
            stroke="var(--background)"
            className="size-4.5"
          />
        }
      />
      <TooltipContent>
        {warnings.map((warning) => (
          <p key={warning}>{warning}</p>
        ))}
      </TooltipContent>
    </Tooltip>
  );
}

export default function Page() {
  const storage = useStorage();
  const preview = useRef<HTMLAudioElement>(null);
  const [values, setValues] = useState<PageValues>(
    () =>
      Object.fromEntries(
        callPageKeys.map((key) => [key, storageDefaults[key]]),
      ) as PageValues,
  );
  const [microphones, setMicrophones] = useState<DeviceOption[]>([]);
  const [speakers, setSpeakers] = useState<DeviceOption[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [isPreviewing, setIsPreviewing] = useState(false);
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const expectedCodec = useCall((state) => state.screenShareExpectedCodec);
  const activeCodec = useCall((state) => state.screenShareActiveCodec);
  const supportedCodecs = getSupportedCallScreenShareCodecs();
  const outputSupported = canSwitchAudioOutput();

  const refresh = useCallback(async () => {
    const loaded = await Promise.all(
      callPageKeys.map((key) => storage.load(key)),
    );
    setValues(
      Object.fromEntries(
        callPageKeys.map((key, index) => [key, loaded[index]]),
      ) as PageValues,
    );
    setLoaded(true);
  }, [storage]);

  const refreshDevices = useCallback(async () => {
    const [inputs, outputs] = await Promise.all([
      getCallDevices("audioinput"),
      outputSupported ? getCallDevices("audiooutput") : Promise.resolve([]),
    ]);
    let inputIndex = 0;
    let outputIndex = 0;
    setMicrophones([
      { id: "default", label: "System default" },
      ...inputs
        .filter((device) => device.deviceId !== "default")
        .map((device) => ({
          id: device.deviceId,
          label: device.label || `Microphone ${++inputIndex}`,
        })),
    ]);
    setSpeakers([
      { id: "default", label: "System default" },
      ...outputs
        .filter((device) => device.deviceId !== "default")
        .map((device) => ({
          id: device.deviceId,
          label: device.label || `Speaker ${++outputIndex}`,
        })),
    ]);
  }, [outputSupported]);

  useEffect(() => {
    void refresh();
    void refreshDevices();
    const unsubscribe = storage.subscribe((keys, bulk) => {
      if (bulk || keys.some((key) => callPageKeys.includes(key as never)))
        void refresh();
    });
    navigator.mediaDevices?.addEventListener("devicechange", refreshDevices);
    return () => {
      unsubscribe();
      navigator.mediaDevices?.removeEventListener(
        "devicechange",
        refreshDevices,
      );
    };
  }, [refresh, refreshDevices, storage]);

  useEffect(() => () => stopSound(preview.current), []);

  function save<K extends (typeof callPageKeys)[number]>(
    key: K,
    value: Storage[K],
  ) {
    setValues((current) => ({ ...current, [key]: value }));
    void storage.save(key, value);
  }

  function stopPreview() {
    stopSound(preview.current);
    preview.current = null;
    setIsPreviewing(false);
  }

  const deepFilterWarning =
    values.call_noise_suppression_enabled && values.call_voice_isolation;
  const agcWarning =
    /Linux/i.test(navigator.userAgent) && values.call_automatic_gain_control;
  const sensitivity = Math.round((-25 - values.call_mute_range_start) * 2);

  if (!loaded) return null;

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-2">
        <h2 className="text-md font-medium">Audio devices</h2>
        <div className="flex gap-5 md:gap-2! flex-col md:flex-row!">
          <div className="flex flex-col gap-2">
            <Label
              className="flex items-center gap-2"
              htmlFor="call-microphone"
            >
              Microphone
            </Label>
            <Select
              value={values.call_microphone_device_id}
              onValueChange={(value) => {
                const next = value ?? "default";
                void switchCallDevice("audioinput", next)
                  .then((switched) => {
                    if (!switched)
                      throw new Error("Microphone switch was rejected.");
                    save("call_microphone_device_id", next);
                  })
                  .catch(() => toast("error", "Failed to switch microphone."));
              }}
            >
              <SelectTrigger className="w-auto md:w-55!" id="call-microphone">
                <SelectValue>
                  {microphones.find(
                    (device) => device.id === values.call_microphone_device_id,
                  )?.label ?? "Select microphone"}
                </SelectValue>
              </SelectTrigger>
              <SelectContent className="p-1">
                {microphones.map((device) => (
                  <SelectItem key={device.id} value={device.id}>
                    {device.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="flex flex-col gap-2">
            <Label className="flex items-center gap-2" htmlFor="call-speaker">
              Speaker
            </Label>
            <Select
              disabled={!outputSupported}
              value={values.call_speaker_device_id}
              onValueChange={(value) => {
                const next = value ?? "default";
                void switchCallDevice("audiooutput", next)
                  .then((switched) => {
                    if (!switched)
                      throw new Error("Speaker switch was rejected.");
                    save("call_speaker_device_id", next);
                  })
                  .catch(() => toast("error", "Failed to switch speaker."));
              }}
            >
              <SelectTrigger className="w-auto md:w-55!" id="call-speaker">
                <SelectValue>
                  {speakers.find(
                    (device) => device.id === values.call_speaker_device_id,
                  )?.label ?? "Select speaker"}
                </SelectValue>
              </SelectTrigger>
              <SelectContent className="p-1">
                {speakers.map((device) => (
                  <SelectItem key={device.id} value={device.id}>
                    {device.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {!outputSupported ? (
              <p className="text-muted-foreground text-xs">
                This browser cannot route audio to a selected speaker.
              </p>
            ) : null}
          </div>
        </div>
      </div>

      <div className="flex flex-col gap-3.5">
        <h2 className="text-md font-medium">Audio processing</h2>
        <div className="flex flex-col gap-2">
          <LabeledSwitch
            id="call-noise-suppression"
            label={
              <span className="flex items-center gap-2">
                Noise suppression
                <WarningIndicator
                  warnings={
                    deepFilterWarning
                      ? [
                          "It is not recommended to use noise suppression and voice isolation together.",
                        ]
                      : []
                  }
                />
              </span>
            }
            checked={values.call_noise_suppression_enabled}
            onCheckedChange={(value) =>
              save("call_noise_suppression_enabled", value)
            }
          />
          <div className="flex flex-col gap-2 w-auto md:w-100! pl-2">
            <div className="flex justify-between text-sm">
              <Label htmlFor="call-noise-strength">
                Noise suppression strength
              </Label>
              <span>{values.call_noise_suppression_level}%</span>
            </div>
            <Slider
              id="call-noise-strength"
              min={0}
              max={100}
              step={1}
              value={[values.call_noise_suppression_level]}
              disabled={!values.call_noise_suppression_enabled}
              onValueChange={(value) =>
                save("call_noise_suppression_level", sliderValue(value, 100))
              }
            />
          </div>
        </div>
        <LabeledSwitch
          id="call-echo-cancellation"
          label={
            <span className="flex items-center gap-2">Echo cancellation</span>
          }
          checked={values.call_echo_cancellation}
          onCheckedChange={(value) => save("call_echo_cancellation", value)}
        />
        <LabeledSwitch
          id="call-voice-isolation"
          label={
            <span className="flex items-center gap-2">
              Voice isolation
              <WarningIndicator
                warnings={
                  deepFilterWarning
                    ? [
                        "It is not recommended to use noise suppression and voice isolation together.",
                      ]
                    : []
                }
              />
            </span>
          }
          checked={values.call_voice_isolation}
          onCheckedChange={(value) => save("call_voice_isolation", value)}
        />
        <LabeledSwitch
          id="call-automatic-gain"
          label={
            <span className="flex items-center gap-2">
              Automatic gain control
              <WarningIndicator
                warnings={
                  agcWarning
                    ? [
                        "Automatic gain control may make you extremely quiet on Linux.",
                      ]
                    : []
                }
              />
            </span>
          }
          checked={values.call_automatic_gain_control}
          onCheckedChange={(value) =>
            save("call_automatic_gain_control", value)
          }
        />
      </div>

      <div className="flex flex-col gap-2">
        <h2 className="text-lg font-semibold">Incoming call sound</h2>
        <div className="flex gap-2">
          <Select
            value={values["settings.call_jingle"]}
            onValueChange={(value) => {
              stopPreview();
              save("settings.call_jingle", value ?? "jingle_1");
            }}
          >
            <SelectTrigger className="w-auto md:w-40!" id="call-jingle">
              <SelectValue>
                {jingleLabels[values["settings.call_jingle"]]}
              </SelectValue>
            </SelectTrigger>
            <SelectContent className="p-1">
              <SelectItem value="jingle_1">Jingle 1</SelectItem>
              <SelectItem value="jingle_2">Jingle 2</SelectItem>
            </SelectContent>
          </Select>
          <Button
            variant="outline"
            onClick={() => {
              if (isPreviewing) return stopPreview();
              const audio = playSound(
                values["settings.call_jingle"] === "jingle_2"
                  ? "call_jingle_2"
                  : "call_jingle_1",
                false,
                values.call_sound_volume / 100,
              );
              preview.current = audio;
              setIsPreviewing(true);
              audio.addEventListener(
                "ended",
                () => preview.current === audio && stopPreview(),
                { once: true },
              );
            }}
          >
            {isPreviewing ? <Square /> : <Play />}
          </Button>
        </div>
      </div>

      <Collapsible open={advancedOpen} onOpenChange={setAdvancedOpen}>
        <CollapsibleTrigger
          render={({ onClick }) => (
            <Button onClick={onClick} variant="outline">
              Advanced Options
              <ChevronDown
                className={`size-4 transition-transform ${advancedOpen ? "rotate-180" : ""}`}
              />
            </Button>
          )}
        />
        <CollapsibleContent className="space-y-5 pt-5">
          <div className="flex flex-col gap-2">
            <LabeledSwitch
              id="call-noise-gate"
              label="Noise gate"
              checked={values.call_noise_gate_enabled}
              onCheckedChange={(value) =>
                save("call_noise_gate_enabled", value)
              }
            />
            <div className="flex flex-col gap-2 w-auto md:w-100! pl-2">
              <div className="flex justify-between text-sm">
                <Label htmlFor="call-gate-sensitivity">
                  Noise gate sensitivity
                </Label>
                <span>{sensitivity}%</span>
              </div>
              <Slider
                id="call-gate-sensitivity"
                min={0}
                max={100}
                step={1}
                value={[sensitivity]}
                disabled={!values.call_noise_gate_enabled}
                onValueChange={(value) => {
                  const next = sliderValue(value, 100);
                  const close = -25 - next / 2;
                  save("call_mute_range_start", close);
                  void storage.save("call_mute_range_end", close + 10);
                }}
              />
            </div>
          </div>
          <div className="flex flex-col gap-3">
            <Label htmlFor="call-screen-codec">Screen-share codec</Label>
            <div className="flex gap-2">
              <Select
                value={
                  values.call_screen_share_codec === "auto" ||
                  supportedCodecs.includes(values.call_screen_share_codec)
                    ? values.call_screen_share_codec
                    : "auto"
                }
                onValueChange={(value) =>
                  save(
                    "call_screen_share_codec",
                    (value ?? "auto") as CallCodec,
                  )
                }
              >
                <SelectTrigger id="call-screen-codec">
                  <SelectValue>
                    {
                      codecLabels[
                        values.call_screen_share_codec === "auto" ||
                        supportedCodecs.includes(values.call_screen_share_codec)
                          ? values.call_screen_share_codec
                          : "auto"
                      ]
                    }
                  </SelectValue>
                </SelectTrigger>
                <SelectContent className="p-1">
                  <SelectItem value="auto">Automatic</SelectItem>
                  {supportedCodecs.map((codec) => (
                    <SelectItem key={codec} value={codec}>
                      {codecLabels[codec]}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <p className="text-muted-foreground text-xs">
                {activeCodec
                  ? `Active codec: ${activeCodec.toUpperCase()}`
                  : `Expected codec: ${(expectedCodec ?? "vp8").toUpperCase()}`}
                <br />
                Supported codecs:{" "}
                {supportedCodecs
                  .map((codec) => codecLabels[codec])
                  .join(", ") || "VP8"}
              </p>
            </div>
          </div>
          <div className="flex flex-col gap-2">
            <LabeledSwitch
              id="call-event-sounds"
              label={
                <span className="flex items-center gap-2">Call sounds</span>
              }
              checked={values.call_event_sounds_enabled}
              onCheckedChange={(value) =>
                save("call_event_sounds_enabled", value)
              }
            />
            <div className="flex flex-col gap-2 w-auto md:w-100! pl-2">
              <div className="flex justify-between text-sm">
                <Label htmlFor="call-sound-volume">Call sound volume</Label>
                <span>{values.call_sound_volume}%</span>
              </div>
              <Slider
                id="call-sound-volume"
                min={0}
                max={100}
                step={1}
                value={[values.call_sound_volume]}
                onValueChange={(value) =>
                  save("call_sound_volume", sliderValue(value, 100))
                }
              />
            </div>
          </div>
        </CollapsibleContent>
      </Collapsible>
    </div>
  );
}
