import { afterEach, describe, expect, it, vi } from "vitest";
import {
  fetchAccountIdentity,
  fetchAccountOmikron,
  NotFoundError,
} from "./omega";
import { ProvisioningUnavailableError } from "./errors";

afterEach(() => vi.unstubAllGlobals());

describe("password discovery HTTP contract", () => {
  it("retains Omega's authority#user principal for the OPAQUE binding", async () => {
    const account = {
      username: "alice",
      user_id: 7,
      iota_id: 11,
      principal: `omega-key:${"a".repeat(64)}#7`,
      public_key: "AQ==",
    };
    const fetch = vi.fn().mockResolvedValue(Response.json(account));
    vi.stubGlobal("fetch", fetch);
    await expect(
      fetchAccountIdentity("https://omega.invalid/", "alice"),
    ).resolves.toEqual(account);
    expect(fetch.mock.calls[0][0].href).toBe(
      "https://omega.invalid/api/get/id/alice",
    );
  });

  it("uses Iota discovery without confusing it with an Omikron ID", async () => {
    const endpoint = {
      id: 42,
      ip_address: "relay.invalid",
      port: 443,
      public_key: "AQ==",
    };
    const fetch = vi.fn().mockResolvedValue(Response.json(endpoint));
    vi.stubGlobal("fetch", fetch);
    await expect(
      fetchAccountOmikron("https://omega.invalid/", 7),
    ).resolves.toEqual(endpoint);
    expect(fetch.mock.calls[0][0].href).toBe(
      "https://omega.invalid/api/get/iota/7/omikron",
    );
  });

  it("distinguishes missing accounts from dependency outages and malformed discovery", async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(new Response(null, { status: 404 }))
      .mockResolvedValueOnce(new Response(null, { status: 503 }))
      .mockResolvedValueOnce(Response.json({ username: "alice" }));
    vi.stubGlobal("fetch", fetch);
    await expect(
      fetchAccountIdentity("https://omega.invalid/", "alice"),
    ).rejects.toBeInstanceOf(NotFoundError);
    await expect(
      fetchAccountIdentity("https://omega.invalid/", "alice"),
    ).rejects.toBeInstanceOf(ProvisioningUnavailableError);
    await expect(
      fetchAccountIdentity("https://omega.invalid/", "alice"),
    ).rejects.toThrow("invalid discovery data");
  });

  it("preserves cancellation and combines it with the discovery deadline", async () => {
    const owner = new AbortController();
    const reason = new Error("Account replaced");
    let requestSignal: AbortSignal | undefined;
    vi.stubGlobal(
      "fetch",
      vi.fn((_url: URL, options: RequestInit) => {
        requestSignal = options.signal as AbortSignal;
        return new Promise((_resolve, reject) => {
          requestSignal!.addEventListener(
            "abort",
            () => reject(requestSignal!.reason),
            { once: true },
          );
        });
      }),
    );
    const request = fetchAccountIdentity(
      "https://omega.invalid/",
      "alice",
      owner.signal,
    );
    expect(requestSignal).not.toBe(owner.signal);
    owner.abort(reason);
    await expect(request).rejects.toBe(reason);
    expect(requestSignal?.aborted).toBe(true);
  });
});
