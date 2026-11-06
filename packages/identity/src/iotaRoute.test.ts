import { expect, it, vi } from "vitest";
import { fetchIotaRoute } from "./iotaRoute";

it("fetches the current route again after a previous successful lookup", async () => {
  const send = vi
    .fn<Parameters<typeof fetchIotaRoute>[1]>()
    .mockResolvedValueOnce({
      type: "GetIotaData",
      data: { IotaId: 12, PublicKey: "AQID" },
    })
    .mockResolvedValueOnce({
      type: "GetIotaData",
      data: { IotaId: 34, PublicKey: "BAUG" },
    });
  expect(await fetchIotaRoute(7, send)).toEqual({
    IotaId: 12,
    PublicKey: "AQID",
  });
  expect(await fetchIotaRoute(7, send)).toEqual({
    IotaId: 34,
    PublicKey: "BAUG",
  });
  expect(send.mock.calls).toEqual([
    ["GetIotaData", { UserId: 7 }],
    ["GetIotaData", { UserId: 7 }],
  ]);
});

it("does not return a previously successful route when current discovery is unavailable", async () => {
  const send = vi
    .fn<Parameters<typeof fetchIotaRoute>[1]>()
    .mockResolvedValueOnce({
      type: "GetIotaData",
      data: { IotaId: 12, PublicKey: "AQID" },
    })
    .mockRejectedValueOnce(new Error("discovery unavailable"))
    .mockResolvedValueOnce({ type: "ErrorInternal", data: {} });
  await fetchIotaRoute(7, send);
  await expect(fetchIotaRoute(7, send)).rejects.toThrow(
    "discovery unavailable",
  );
  await expect(fetchIotaRoute(7, send)).rejects.toThrow("GetIotaData failed");
});

it("rejects malformed replies and invalid selectors without a cache fallback", async () => {
  const send = vi.fn<Parameters<typeof fetchIotaRoute>[1]>().mockResolvedValue({
    type: "GetIotaData",
    data: { IotaId: 12, PublicKey: "not a public bundle" },
  });
  await expect(fetchIotaRoute(7, send)).rejects.toThrow();
  send.mockClear();
  for (const userId of [0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1])
    await expect(fetchIotaRoute(userId, send)).rejects.toThrow();
  expect(send).not.toHaveBeenCalled();
});
