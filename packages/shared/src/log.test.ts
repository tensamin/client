import { afterEach, expect, it, vi } from "vitest";
import { logMTP } from "./log";

vi.mock("@nonanium/ui", () => ({ toast: vi.fn() }));

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it("logs protocol metadata without payloads or error text even at debug level", () => {
  vi.stubGlobal("localStorage", { getItem: () => "3" });
  const output = vi.spyOn(console, "log").mockImplementation(() => {});
  const groups = vi
    .spyOn(console, "groupCollapsed")
    .mockImplementation(() => {});
  vi.spyOn(console, "groupEnd").mockImplementation(() => {});
  const secret = "do-not-log-this-bearer-token-or-key";
  logMTP({
    hint: "info",
    type: "TAuthExchangeCodeResponse",
    direction: "recv",
    data: { SessionToken: secret },
  });
  logMTP({
    hint: "warning",
    type: "PasswordEnrollmentFinish",
    data: { privateKey: secret },
  });
  logMTP({
    hint: "error",
    type: "PasswordEnrollmentStatus",
    error: secret,
    data: { frame: secret },
  });
  logMTP({
    hint: "info",
    type: "Relay",
    data: secret,
    relay: {
      signerId: 1n,
      finalRecipientId: 2n,
      messageId: 3n,
      createdAt: 4n,
    },
  });
  const logged = JSON.stringify(
    [output.mock.calls, groups.mock.calls],
    (_key, value) => (typeof value === "bigint" ? value.toString() : value),
  );
  expect(logged).not.toContain(secret);
  expect(logged).toContain("TAuthExchangeCodeResponse");
  expect(logged).toContain("PasswordEnrollmentStatus");
  expect(output).toHaveBeenCalledWith({
    signerId: 1n,
    finalRecipientId: 2n,
    messageId: 3n,
    createdAt: 4n,
  });
});
