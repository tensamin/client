import { expect, it, vi } from "vitest";
import { bytesToBase64 } from "mtp";
import type { WirePrincipal } from "@tensamin/shared/principal";
import type { createPrincipalProofResolver } from "./principalProof";
import type { SealedRelaySend } from "./mtpContext";
import { createPrincipalRelaySender } from "./principalRelay";

const owner = { authority: `omega-key:${"a".repeat(64)}`, user_id: 7 };
const peer = { authority: `omega-key:${"b".repeat(64)}`, user_id: 7 };
const dictionary = { version: "1.1", fingerprint: "c".repeat(64) };
function proof(
  principal: WirePrincipal,
  homePublicKey: Uint8Array,
  publicKey: Uint8Array,
) {
  return {
    principal,
    homePublicKey,
    publicKeys: [publicKey],
    home: `iota:v1:${"d".repeat(64)}`,
    revision: 1n,
    validUntil: BigInt(Date.now() + 60_000),
    username: undefined,
    displayName: undefined,
  };
}
function setup() {
  // Proof verification is the resolver's boundary. These opaque byte fixtures
  // distinguish the already-verified routing/key inputs supplied to this layer.
  const self = proof(
    { ...owner, user_id: 7n },
    Uint8Array.of(1, 2, 3),
    Uint8Array.of(4, 5, 6),
  );
  const recipient = proof(
    { ...peer, user_id: 7n },
    Uint8Array.of(7, 8, 9),
    Uint8Array.of(10, 11, 12),
  );
  const resolve = vi.fn<ReturnType<typeof createPrincipalProofResolver>>(
    async (who) => (who.authority === owner.authority ? self : recipient),
  );
  const ownIota = vi.fn(async () => ({
    IotaId: 12,
    PublicKey: bytesToBase64(self.homePublicKey),
  }));
  const send = vi
    .fn<SealedRelaySend>()
    .mockResolvedValue({ type: "Success", data: {} });
  const controller = new AbortController();
  const relay = createPrincipalRelaySender({
    owner,
    dictionary,
    resolve,
    ownIota,
    send,
    signal: controller.signal,
  });
  return { self, recipient, resolve, ownIota, send, controller, relay };
}

it("keeps equal numeric IDs in different authorities distinct and passes application data unchanged", async () => {
  const { relay, send, self, recipient } = setup();
  const data = { Json: "opaque signed file offer" };
  await relay(peer, "FileShareOffered", data);
  const [type, body, options] = send.mock.calls[0];
  expect(type).toBe("FileShareOffered");
  expect(body).toBe(data);
  expect(options.nextHop).toEqual({ kind: "iota", id: 12 });
  expect(options.finalRecipientId).toBe(7);
  expect(
    JSON.parse(new TextDecoder().decode(options.metadata as Uint8Array)),
  ).toEqual({
    signer: owner,
    recipient: peer,
    destination: recipient.home,
    type_map_version: dictionary.version,
    type_map_fingerprint: dictionary.fingerprint,
  });
  expect(options.contentRecipients).toEqual(
    [self.homePublicKey, recipient.homePublicKey, recipient.publicKeys[0]].map(
      (value) => ({ value: bytesToBase64(value), encoding: "base64" }),
    ),
  );
  expect(options.metadataRecipients).toEqual(options.contentRecipients);
});

it("refuses a cached route whose key contradicts the fresh signed sender home", async () => {
  const { relay, ownIota, send } = setup();
  ownIota.mockResolvedValue({ IotaId: 12, PublicKey: "stale-key" });
  await expect(relay(peer, "MessageSend", {})).rejects.toThrow(
    "authenticated sender home",
  );
  expect(send).not.toHaveBeenCalled();
});

it("rejects proof aliasing and ambiguous active keys instead of selecting a numeric or historical fallback", async () => {
  const wrong = setup();
  wrong.recipient.principal = wrong.self.principal;
  await expect(wrong.relay(peer, "MessageSend", {})).rejects.toThrow(
    "another principal",
  );
  expect(wrong.send).not.toHaveBeenCalled();
  const ambiguous = setup();
  ambiguous.recipient.publicKeys.push(ambiguous.self.publicKeys[0]);
  await expect(ambiguous.relay(peer, "MessageSend", {})).rejects.toThrow(
    "exactly one active key",
  );
  expect(ambiguous.send).not.toHaveBeenCalled();
});

it("uses the SDK route-ID validation before handing anything to the transport", async () => {
  const { relay, ownIota, self, send } = setup();
  for (const IotaId of [0, -1, 1.5, 2 ** 48]) {
    ownIota.mockResolvedValue({
      IotaId,
      PublicKey: bytesToBase64(self.homePublicKey),
    });
    await expect(relay(peer, "MessageSend", {})).rejects.toThrow();
  }
  expect(send).not.toHaveBeenCalled();
});

it("cancels after concurrent identity resolution without transmitting", async () => {
  const { relay, resolve, controller, self, send } = setup();
  resolve.mockImplementationOnce(async () => {
    await Promise.resolve();
    controller.abort();
    return self;
  });
  await expect(relay(peer, "MessageSend", {})).rejects.toThrow();
  expect(send).not.toHaveBeenCalled();
});
