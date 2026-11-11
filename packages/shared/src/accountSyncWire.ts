import type { MTPDataValueInput } from "mtp";

const fields = {
  operation: "SyncOperation",
  scope: "SyncScope",
  principal: "SyncPrincipal",
  authority: "SyncAuthority",
  user_id: "SyncUserId",
  device_id: "SyncDeviceId",
  authorization_generation: "SyncAuthorizationGeneration",
  schema: "SyncSchema",
  dictionary: "SyncDictionary",
  page: "SyncPage",
  limit: "SyncLimit",
  after: "SyncAfter",
  cursor: "SyncCursor",
  page_id: "SyncPageId",
  state: "SyncState",
  head: "SyncHead",
  floor: "SyncFloor",
  next: "SyncNext",
  records: "SyncRecords",
  events: "SyncEvents",
  sequence: "SyncSequence",
  event_id: "SyncEventId",
  entity: "SyncEntity",
  key: "SyncKey",
  value: "SyncValue",
  record: "SyncRecord",
  error: "SyncError",
  id: "SyncId",
  offset: "SyncOffset",
} as const;
const names = new Map(
  Object.entries(fields).map(([name, field]) => [field as string, name]),
);
type Value =
  null | boolean | number | string | Value[] | { [key: string]: Value };

function validate(value: unknown, limit: number) {
  let count = 0;
  let bytes = 0;
  const encoder = new TextEncoder();
  function visit(value: unknown, depth: number) {
    if (++count > 65_536 || depth > 32)
      throw new Error("Account sync exceeds codec limits");
    if (value === null || typeof value === "boolean") bytes += 1;
    else if (typeof value === "number" && Number.isFinite(value)) bytes += 17;
    else if (typeof value === "string")
      bytes += 5 + encoder.encode(value).length;
    else if (Array.isArray(value)) {
      bytes += 5;
      value.forEach((item) => visit(item, depth + 1));
    } else if (
      typeof value === "object" &&
      value !== null &&
      (Object.getPrototypeOf(value) === Object.prototype ||
        Object.getPrototypeOf(value) === null)
    ) {
      bytes += 5;
      for (const item of Object.values(value)) {
        bytes += 2;
        visit(item, depth + 1);
      }
    } else throw new Error("Invalid account sync codec value");
    if (bytes > limit) throw new Error("Account sync exceeds its byte limit");
  }
  visit(value, 0);
}

function convert(
  value: unknown,
  decoding: boolean,
  recordValue = false,
  depth = 0,
): Value {
  if (depth > 32) throw new Error("Account sync exceeds codec depth");
  if (value === null || typeof value === "string" || typeof value === "boolean")
    return value;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (Array.isArray(value))
    return value.map((item) => convert(item, decoding, recordValue, depth + 1));
  if (typeof value !== "object") throw new Error("Invalid account sync value");
  const entries = Object.entries(value);
  if (recordValue) {
    if (!decoding)
      return {
        SyncEntries: entries.map(([key, item]) => [
          key,
          convert(item, false, true, depth + 2),
        ]),
      };
    if (
      entries.length !== 1 ||
      entries[0][0] !== "SyncEntries" ||
      !Array.isArray(entries[0][1])
    )
      throw new Error("Invalid account sync record entries");
    const seen = new Set<string>();
    return Object.fromEntries(
      entries[0][1].map((pair: unknown) => {
        if (
          !Array.isArray(pair) ||
          pair.length !== 2 ||
          typeof pair[0] !== "string" ||
          seen.has(pair[0])
        )
          throw new Error("Invalid account sync record entry");
        seen.add(pair[0]);
        return [pair[0], convert(pair[1], true, true, depth + 2)];
      }),
    );
  }
  return Object.fromEntries(
    entries.map(([key, item]) => {
      const name = decoding
        ? names.get(key)
        : Object.prototype.hasOwnProperty.call(fields, key)
          ? key
          : undefined;
      if (!name) throw new Error("Unknown account sync field");
      return [
        decoding ? name : fields[name as keyof typeof fields],
        convert(item, decoding, name === "value", depth + 1),
      ];
    }),
  );
}

export function encodeAccountSync(request: object): MTPDataValueInput {
  const value = convert(request, false);
  validate(value, 4096);
  return value;
}

export function decodeAccountSync(value: unknown): unknown {
  validate(value, 1024 * 1024);
  return convert(value, true);
}
