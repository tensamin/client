/// <reference types="node" />
import { describe, expect, it } from "vitest";
import {
  deriveChatId,
  encodePrincipal,
  parsePrincipal,
  parseWirePrincipal,
} from "./principal";

const authority = `omega-key:${"a".repeat(64)}`;

const a = { authority, user_id: 42 };
const b = { authority: `omega-key:${"b".repeat(64)}`, user_id: 42 };

describe("Tau conversation identities", () => {
  it("matches the bytes emitted by Tau ccbdcb8 for colliding authority-local IDs", () => {
    const golden =
      "principal:W3siYXV0aG9yaXR5Ijoib21lZ2Eta2V5OmFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWEiLCJ1c2VyX2lkIjo0Mn0seyJhdXRob3JpdHkiOiJvbWVnYS1rZXk6YmJiYmJiYmJiYmJiYmJiYmJiYmJiYmJiYmJiYmJiYmJiYmJiYmJiYmJiYmJiYmJiYmJiYmJiYmJiYmJiYmJiYiIsInVzZXJfaWQiOjQyfV0";
    expect(deriveChatId(a, b)).toBe(golden);
    expect(deriveChatId(b, a)).toBe(golden);
    expect(deriveChatId(a, { ...b, user_id: 43 })).not.toBe(golden);
    expect(() => deriveChatId(a, a)).toThrow();
  });

  it("sorts IDs numerically within one authority", () => {
    const chat = deriveChatId({ ...a, user_id: 11 }, { ...a, user_id: 2 });
    expect(atob(chat.slice("principal:".length))).toBe(
      `[${encodePrincipal({ ...a, user_id: 2 })},${encodePrincipal({ ...a, user_id: 11 })}]`,
    );
  });

  it("rejects JSON aliases, unknown fields and IDs that JavaScript cannot represent exactly", () => {
    for (const input of [
      "42",
      JSON.stringify({ user_id: 42, authority: a.authority }),
      `{"authority":"${a.authority}","user_id":42,"user_id":43}`,
      JSON.stringify({ ...a, extra: true }),
      JSON.stringify({ ...a, user_id: "42" }),
      JSON.stringify({ ...a, user_id: 0 }),
      JSON.stringify({ ...a, user_id: Number.MAX_SAFE_INTEGER + 1 }),
    ]) {
      expect(() => parsePrincipal(input)).toThrow();
    }
    expect(parsePrincipal(encodePrincipal(a))).toEqual(a);
  });
});

it("preserves the backend's positive i64 principal domain without rounding", () => {
  const json = `{"authority":"${authority}","user_id":9223372036854775807}`;
  const principal = parseWirePrincipal(json);
  expect(principal.user_id).toBe(9223372036854775807n);
  expect(encodePrincipal(principal)).toBe(json);
  expect(() => parsePrincipal(json)).toThrow();
  expect(parsePrincipal(`{"authority":"${authority}","user_id":42}`)).toEqual({
    authority,
    user_id: 42,
  });
  expect(() =>
    encodePrincipal({ authority, user_id: Number.MAX_SAFE_INTEGER + 1 }),
  ).toThrow();
});

it("rejects duplicate, noncanonical and out-of-domain principal fields", () => {
  for (const json of [
    `{"authority":"${authority}","user_id":1,"user_id":2}`,
    `{"authority":"${authority}","user_id":1.0}`,
    `{"authority":"${authority}","user_id":0}`,
    `{"authority":"${authority}","user_id":9223372036854775808}`,
    `{"authority":"${authority}","user_id":18446744073709551616}`,
    `{"user_id":1,"authority":"${authority}"}`,
  ])
    expect(() => parseWirePrincipal(json)).toThrow();
});

it("sorts exact adjacent i64 values and retains the existing safe-number wire bytes", () => {
  const first = { authority, user_id: 9223372036854775806n };
  const second = { authority, user_id: 9223372036854775807n };
  const id = deriveChatId(second, first);
  expect(id).toBe(deriveChatId(first, second));
  const bytes = Buffer.from(
    id.slice("principal:".length),
    "base64url",
  ).toString("utf8");
  expect(bytes).toBe(
    `[{"authority":"${authority}","user_id":9223372036854775806},{"authority":"${authority}","user_id":9223372036854775807}]`,
  );
  expect(
    deriveChatId({ authority, user_id: 2 }, { authority, user_id: 10 }),
  ).toBe(
    "principal:W3siYXV0aG9yaXR5Ijoib21lZ2Eta2V5OmFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWEiLCJ1c2VyX2lkIjoyfSx7ImF1dGhvcml0eSI6Im9tZWdhLWtleTphYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhIiwidXNlcl9pZCI6MTB9XQ",
  );
});
