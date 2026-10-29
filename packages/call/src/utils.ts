export function displayCallId(callId: string) {
  const isUuid =
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      callId,
    );

  if (!isUuid) {
    return callId.length > 8 ? callId.slice(0, 8) + "..." : callId;
  }

  const upper = callId.toUpperCase();
  return upper.slice(0, 4) + "..." + upper.slice(-4);
}
