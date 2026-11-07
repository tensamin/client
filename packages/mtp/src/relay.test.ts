import { describe, expect, it, vi } from "vitest";
import type {
  MTPClient,
  MTPVerifiedRelayMetadata,
  MTPOpenRelayMetadataOptions,
  MTPOpenRelayContentOptions,
  ParsedFrame,
} from "mtp";
import { encodePrincipal } from "@tensamin/shared/principal";
import { mtp as mtpSchemas } from "@tensamin/shared/data";
import type { ProtocolMessage } from "./mtpContext";
import { subscribeCommittedRelays } from "./relay";
import {
  decodeFileResponse,
  encodeFileRequest,
  wireFileShareRevoke,
} from "./files/protocol";

// Signature/proof verification and journal transactions have real-crypto/DB
// regressions elsewhere. Here their boundaries control acknowledgement ordering.
const fileDelivery = vi.hoisted(() => ({
  synchronize: vi.fn(),
  grant: vi.fn(),
  verify: vi.fn(),
}));
vi.mock("./files/accountJournal", () => ({
  createAccountFileJournal: () => ({
    synchronize: fileDelivery.synchronize,
    grant: fileDelivery.grant,
  }),
}));
vi.mock("./fileSigningKey", () => ({
  createFileAuthorResolver: () => async (principal: unknown) => ({
    principal,
    publicKeys: [],
  }),
}));
vi.mock("@tensamin/crypto/fileSharing", async (original) => ({
  ...(await original<typeof import("@tensamin/crypto/fileSharing")>()),
  verifyFileShareOffer: fileDelivery.verify,
  verifyFileShareRevoke: fileDelivery.verify,
}));

vi.mock("./principalProof", () => ({
  createPrincipalProofResolver:
    () => async (principal: { authority: string }) => ({
      publicKeys: [
        principal.authority === `omega-key:${"d".repeat(64)}`
          ? Uint8Array.of(1, 2, 3)
          : Uint8Array.of(4, 5, 6),
      ],
    }),
}));

const authority = `omega-key:${"a".repeat(64)}`;
const owner = { authority, user_id: 7 };
const peer = { authority: `omega-key:${"d".repeat(64)}`, user_id: 7 };
const peerPrincipal = encodePrincipal(peer);
const dictionary = "b".repeat(64);

function fixture() {
  const state = {
    Scope: { principal: owner, dictionary },
    Contacts: [{ UserId: 901, Principal: peerPrincipal }],
  } as ProtocolMessage<"AccountStateSnapshot">["data"];
  const refresh = vi.fn<() => Promise<typeof state>>().mockResolvedValue(state);
  const events: string[] = [];
  refresh.mockImplementation(async () => {
    events.push("refresh");
    return state;
  });
  let handler:
    | ((
        opened: MTPVerifiedRelayMetadata,
        frame: ParsedFrame,
      ) => void | Promise<void>)
    | undefined;
  const send = vi.fn(async () => {
    events.push("ack");
  });
  let subscriptionOptions: MTPOpenRelayMetadataOptions | undefined;
  const openRelayContent = vi.fn<
    (
      verified: MTPVerifiedRelayMetadata,
      options: MTPOpenRelayContentOptions,
    ) => Promise<{ type: string; data?: { Json: string } }>
  >(async () => {
    events.push("open");
    return { type: "MessageSend" };
  });
  const client = {
    dictionaryIdentity: { version: "1.0", fingerprint: dictionary },
    subscribeRelayMetadata: vi.fn(
      (callback: typeof handler, options: MTPOpenRelayMetadataOptions) => {
        handler = callback;
        subscriptionOptions = options;
        return () => undefined;
      },
    ),
    request: vi.fn(),
    send,
    openRelayContent,
  } as unknown as MTPClient<typeof mtpSchemas>;
  const dispose = subscribeCommittedRelays(client, refresh);
  const metadata = new TextEncoder().encode(
    JSON.stringify({
      signer: peer,
      recipient: owner,
      destination: `iota:v1:${"c".repeat(64)}`,
      type_map_version: "1.0",
      type_map_fingerprint: dictionary,
    }),
  );
  const opened = {
    signerId: 7n,
    finalRecipientId: 7n,
    messageId: 99n,
    metadata,
    matchedSignerPublicKey: Uint8Array.of(1, 2, 3),
  } as MTPVerifiedRelayMetadata;
  return {
    events,
    handler: handler!,
    opened,
    send,
    dispose,
    refresh,
    subscriptionOptions: subscriptionOptions!,
    openRelayContent,
  };
}

describe("committed relay delivery", () => {
  it("does not acknowledge a signed file operation until durable journal application completes", async () => {
    const { handler, opened, send, dispose, openRelayContent, events } =
      fixture();
    const payload = {
      key: {
        origin: { ...peer, user_id: 7n },
        file_id: "file-one",
        version: 1n,
      },
      recipient: { ...owner, user_id: 7n },
      chat_id: "principal:fixture",
      grant_revision: 2n,
      signing_public_key: "AQID",
      signature: Uint8Array.of(1),
    };
    openRelayContent.mockResolvedValue({
      type: "FileShareRevoked",
      data: { Json: encodeFileRequest(payload) },
    });
    fileDelivery.grant.mockResolvedValue({
      kind: "share_revoked",
      payload: decodeFileResponse(
        encodeFileRequest(payload),
        wireFileShareRevoke,
      ),
    });
    fileDelivery.synchronize.mockRejectedValueOnce(
      new Error("durable commit refused"),
    );
    await expect(handler(opened, { id: 12 } as ParsedFrame)).rejects.toThrow(
      "durable commit refused",
    );
    expect(send).not.toHaveBeenCalled();
    fileDelivery.synchronize.mockImplementationOnce(async () => {
      events.push("file-commit");
    });
    await handler(opened, { id: 13 } as ParsedFrame);
    expect(fileDelivery.verify).toHaveBeenCalled();
    expect(events.indexOf("file-commit")).toBeLessThan(events.indexOf("ack"));
    expect(send).toHaveBeenCalledTimes(1);
    dispose();
  });

  it("does not acknowledge an uncommitted or conflicting file grant revision", async () => {
    const { handler, opened, send, dispose, openRelayContent } = fixture();
    const payload = {
      key: {
        origin: { ...peer, user_id: 7n },
        file_id: "file-one",
        version: 1n,
      },
      recipient: { ...owner, user_id: 7n },
      chat_id: "principal:fixture",
      grant_revision: 2n,
      signing_public_key: "AQID",
      signature: Uint8Array.of(1),
    };
    openRelayContent.mockResolvedValue({
      type: "FileShareRevoked",
      data: { Json: encodeFileRequest(payload) },
    });
    fileDelivery.synchronize.mockResolvedValue(undefined);
    fileDelivery.grant.mockResolvedValueOnce(undefined);
    await expect(handler(opened, { id: 12 } as ParsedFrame)).rejects.toThrow(
      "durable file journal",
    );
    fileDelivery.grant.mockResolvedValueOnce({
      kind: "share_revoked",
      payload: { ...payload, signature: Uint8Array.of(2) },
    });
    await expect(handler(opened, { id: 13 } as ParsedFrame)).rejects.toThrow(
      "conflicts",
    );
    expect(send).not.toHaveBeenCalled();
    dispose();
  });
  it("resolves canonical keys and acknowledges only after synchronization", async () => {
    const {
      events,
      handler,
      opened,
      send,
      dispose,
      refresh,
      subscriptionOptions,
      openRelayContent,
    } = fixture();
    const keys = await subscriptionOptions.resolveSignerPublicKeys!(7n);
    expect(keys).toEqual([Uint8Array.of(4, 5, 6), Uint8Array.of(1, 2, 3)]);
    await handler(opened, { id: 12 } as ParsedFrame);
    const options = openRelayContent.mock.calls[0][1];
    expect(options.expectedSignerId).toBe(7);
    expect(await options.resolveSignerPublicKeys!(7n)).toEqual([
      Uint8Array.of(1, 2, 3),
    ]);
    expect(refresh).toHaveBeenCalled();
    expect(send).toHaveBeenCalledWith(
      "Success",
      { RelayMessageId: "99", Principal: JSON.stringify(peer) },
      { id: 12 },
    );
    expect(events[events.length - 1]).toBe("ack");
    expect(events.indexOf("ack")).toBeGreaterThan(
      events.lastIndexOf("refresh"),
    );
    dispose();
  });

  it("does not acknowledge metadata for another account", async () => {
    const { handler, opened, send, dispose } = fixture();
    const wrong = {
      ...opened,
      metadata: new TextEncoder().encode(
        JSON.stringify({
          signer: peer,
          recipient: { authority, user_id: 9 },
          destination: `iota:v1:${"c".repeat(64)}`,
          type_map_version: "1.0",
          type_map_fingerprint: dictionary,
        }),
      ),
    } as MTPVerifiedRelayMetadata;
    await expect(handler!(wrong, { id: 12 } as ParsedFrame)).rejects.toThrow(
      "outside this account",
    );
    expect(send).not.toHaveBeenCalled();
    dispose();
  });

  it("rejects another authority's key even when the numeric signer ID matches", async () => {
    const { handler, opened, send, dispose, openRelayContent } = fixture();
    await expect(
      handler(
        {
          ...opened,
          matchedSignerPublicKey: Uint8Array.of(4, 5, 6),
        } as MTPVerifiedRelayMetadata,
        { id: 12 } as ParsedFrame,
      ),
    ).rejects.toThrow("does not belong");
    expect(send).not.toHaveBeenCalled();
    expect(openRelayContent).not.toHaveBeenCalled();
    dispose();
  });

  it("does not acknowledge if synchronization fails after opening", async () => {
    const { handler, opened, send, dispose, refresh } = fixture();
    refresh
      .mockResolvedValueOnce(await refresh())
      .mockRejectedValueOnce(new Error("storage failure"));
    await expect(handler(opened, { id: 12 } as ParsedFrame)).rejects.toThrow(
      "storage failure",
    );
    expect(send).not.toHaveBeenCalled();
    dispose();
  });

  it("does not acknowledge after disposal while the content is opening", async () => {
    const { handler, opened, send, dispose, openRelayContent } = fixture();
    openRelayContent.mockImplementationOnce(async () => {
      dispose();
      return { type: "MessageSend" };
    });
    await handler(opened, { id: 12 } as ParsedFrame);
    expect(send).not.toHaveBeenCalled();
  });

  it("does not acknowledge operations without an implemented state consumer", async () => {
    const { handler, opened, send, dispose, openRelayContent } = fixture();
    openRelayContent.mockResolvedValueOnce({ type: "CallToken" });
    await expect(handler(opened, { id: 12 } as ParsedFrame)).rejects.toThrow(
      "Unsupported",
    );
    expect(send).not.toHaveBeenCalled();
    dispose();
  });

  it("allows authenticated redelivery through the idempotent sync and acknowledgement path", async () => {
    const { handler, opened, send, dispose } = fixture();
    await handler(opened, { id: 12 } as ParsedFrame);
    await handler(opened, { id: 13 } as ParsedFrame);
    expect(send).toHaveBeenCalledTimes(2);
    expect(send).toHaveBeenLastCalledWith(
      "Success",
      {
        RelayMessageId: "99",
        Principal: JSON.stringify(peer),
      },
      { id: 13 },
    );
    dispose();
  });

  it("rejects noncanonical routing JSON before opening content", async () => {
    const { handler, opened, send, dispose, openRelayContent } = fixture();
    const text = new TextDecoder().decode(opened.metadata as Uint8Array);
    await expect(
      handler(
        {
          ...opened,
          metadata: new TextEncoder().encode(` ${text}`),
        } as MTPVerifiedRelayMetadata,
        { id: 12 } as ParsedFrame,
      ),
    ).rejects.toThrow("not canonical");
    expect(send).not.toHaveBeenCalled();
    expect(openRelayContent).not.toHaveBeenCalled();
    dispose();
  });
});
