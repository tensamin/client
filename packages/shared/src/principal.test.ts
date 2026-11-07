import { describe, expect, it } from "vitest";
import { deriveChatId, encodePrincipal, parsePrincipal } from "./principal";

const a = { authority: `omega-key:${"a".repeat(64)}`, user_id: 42 };
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
