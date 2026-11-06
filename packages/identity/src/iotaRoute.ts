import type { ProtocolMessage } from "@tensamin/mtp";
import type { z } from "zod";
import { mtp } from "@tensamin/shared/data";

export async function fetchIotaRoute(
  userId: number,
  send: (
    type: "GetIotaData",
    request: z.input<typeof mtp.GetIotaData.request>,
  ) => Promise<ProtocolMessage>,
) {
  const request = mtp.GetIotaData.request.parse({ UserId: userId });
  const response = await send("GetIotaData", request);
  if (response.type !== "GetIotaData")
    throw new Error(`GetIotaData failed: ${response.type}`);
  return mtp.GetIotaData.response.parse(response.data);
}
