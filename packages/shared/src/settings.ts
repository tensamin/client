type StringKeyOf<T> = Extract<keyof T, string>;

export type SettingsSchema = Record<
  string,
  Record<
    string,
    Record<
      string,
      {
        display: string;
        type: string;
        default?: unknown;
      }
    >
  >
>;

const settings = {
  account: {
    profile: {},
    security: {
      login_qr_code: {
        display: "Login QR Code",
        type: "custom",
      },
    },
  },
  accessability: {
    chat: {
      reverse_enter_behavior: {
        display: "Reverse Enter Behavior",
        type: "boolean",
        default: false,
      },
      read_confirmations: {
        display: "Enable Read Confirmations",
        type: "boolean",
        default: true,
      },
      receive_confirmations: {
        display: "Enable Receive Confirmations",
        type: "boolean",
        default: false,
      },
      show_start_of_last_message_in_sidebar: {
        display: "Show Start of Last Message in Sidebar",
        type: "boolean",
        default: true,
      },
    },
  },
  call: {
    call: {
      call_jingle: {
        display: "Incoming call sound",
        type: "select",
        default: "jingle_1" as "jingle_1" | "jingle_2",
      },
    },
  },
  application: {
    accessibility: {
      show_desktop_send_button: {
        display: "Show send button on desktop",
        type: "boolean",
        default: false,
      },
    },
    cache: {},
    theme: {},
    licenses: {},
  },
} as const satisfies SettingsSchema;

// Assemble storage defaults
export default settings;

type SettingStorageEntry<T extends SettingsSchema> = {
  [C in StringKeyOf<T>]: {
    [P in StringKeyOf<T[C]>]: {
      [S in StringKeyOf<T[C][P]>]: T[C][P][S] extends { default: infer V }
        ? { key: `settings.${S}`; value: V }
        : never;
    }[StringKeyOf<T[C][P]>];
  }[StringKeyOf<T[C]>];
}[StringKeyOf<T>];

type Widen<T> = T extends boolean
  ? boolean
  : T extends string
    ? string extends T
      ? string
      : T
    : T extends number
      ? number
      : T;

export type SettingsStorageKey<T extends SettingsSchema = typeof settings> =
  SettingStorageEntry<T>["key"];

export type SettingsStorageDefaults<
  T extends SettingsSchema = typeof settings,
> = {
  [K in SettingsStorageKey<T>]: Widen<
    Extract<SettingStorageEntry<T>, { key: K }>["value"]
  >;
};

function buildSettingsStorageDefaults<T extends SettingsSchema>(
  schema: T,
): SettingsStorageDefaults<T> {
  const defaults: Partial<SettingsStorageDefaults<T>> = {};

  for (const category of Object.values(schema)) {
    for (const page of Object.values(category)) {
      for (const [settingName, setting] of Object.entries(page)) {
        if ("default" in setting) {
          const key = `settings.${settingName}` as SettingsStorageKey<T>;
          defaults[key] =
            setting.default as SettingsStorageDefaults<T>[typeof key];
        }
      }
    }
  }

  return defaults as SettingsStorageDefaults<T>;
}

export const settingsStorageDefaults = buildSettingsStorageDefaults(settings);
