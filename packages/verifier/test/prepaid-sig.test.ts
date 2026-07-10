import { createHash } from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";
import { canonicalize, serializeExtensionBlock, type ExtensionField } from "@chainvue/v402-protocol";
import { InMemoryStorage } from "@chainvue/v402-storage";
import { MockVerusRpc, VerusRpcError, VerusRpcUnavailableError } from "@chainvue/v402-verus-rpc";
import { VerusPrepaidSigVerifier, type IncomingPaymentRequest, type RoutePolicy } from "../src/index.js";

const PAYER = "v402test.demoAgent@";
/** Balance state is keyed by the normalized identity (chain names are case-insensitive). */
const PAYER_KEY = "v402test.demoagent@";
const REQUEST_ID = "01H8XG7Q4M2N8P5R7T3V9WXYZA";
const ISSUED_AT = 1_783_650_000;
const NOW = ISSUED_AT + 5;
const SIGNATURE = "SGVsbG8rL3dvcmxkQUJDRA==";
const POLICY: RoutePolicy = { priceHuman: "0.001", bodyHashPolicy: "optional" };

interface Setup {
  verifier: VerusPrepaidSigVerifier;
  storage: InMemoryStorage;
  rpc: MockVerusRpc;
  capturedCanonicals: string[];
}

async function setup(options: {
  balanceSats?: bigint;
  verifyMessage?: (signer: string, signature: string, message: string) => Promise<boolean>;
  now?: number;
  blocked?: boolean;
} = {}): Promise<Setup> {
  const storage = new InMemoryStorage();
  await storage.initialize();
  if (options.balanceSats !== undefined && options.balanceSats > 0n) {
    const deposit = await storage.insertDeposit({
      identityId: PAYER_KEY,
      amountSats: options.balanceSats,
      currency: "VRSCTEST",
      txid: "fund",
      vout: 0,
      blockHeight: 1,
      blockHash: "h1",
      confirmations: 10,
      detectedAt: ISSUED_AT - 100,
      origin: "real",
    });
    await storage.creditDeposit(deposit.id, ISSUED_AT - 100);
  }
  if (options.blocked === true) {
    await storage.blockIdentity({ identityId: PAYER_KEY, reason: "test", blockedAt: ISSUED_AT - 10 });
  }
  const capturedCanonicals: string[] = [];
  const rpc = new MockVerusRpc({
    verifyMessage:
      options.verifyMessage ??
      (async (_signer, _sig, message) => {
        capturedCanonicals.push(message);
        return true;
      }),
  });
  const verifier = new VerusPrepaidSigVerifier({
    storage,
    rpc,
    config: {
      network: "vrsctest",
      asset: "VRSCTEST",
      payTo: "explorerAPI@",
      canonicalDomain: "explorer.example.com",
    },
    now: () => options.now ?? NOW,
  });
  return { verifier, storage, rpc, capturedCanonicals };
}

function requestFor(overrides: {
  method?: string;
  path?: string;
  scheme?: string;
  amount?: string;
  requestId?: string;
  issuedAt?: number;
  signature?: string;
  extensionsRaw?: string;
  rawBody?: Uint8Array;
  dropHeader?: string;
} = {}): IncomingPaymentRequest {
  const headers: Record<string, string | undefined> = {
    "x-v402-scheme": overrides.scheme ?? "verus-prepaid-sig",
    "x-v402-payer": PAYER,
    "x-v402-amount": overrides.amount ?? "0.001",
    "x-v402-request-id": overrides.requestId ?? REQUEST_ID,
    "x-v402-issued-at": String(overrides.issuedAt ?? ISSUED_AT),
    "x-v402-signature": overrides.signature ?? SIGNATURE,
  };
  if (overrides.extensionsRaw !== undefined) headers["x-v402-extensions"] = overrides.extensionsRaw;
  if (overrides.dropHeader !== undefined) delete headers[overrides.dropHeader];
  const request: IncomingPaymentRequest = {
    method: overrides.method ?? "GET",
    path: overrides.path ?? "/api/tx/abc",
    headers,
  };
  if (overrides.rawBody !== undefined) request.rawBody = overrides.rawBody;
  return request;
}

function expectedCanonical(overrides: { method?: string; path?: string; amount?: string; extensions?: ExtensionField[] } = {}): string {
  return canonicalize({
    scheme: "verus-prepaid-sig",
    schemeVersion: "0.1",
    canonicalDomain: "explorer.example.com",
    method: overrides.method ?? "GET",
    path: overrides.path ?? "/api/tx/abc",
    network: "vrsctest",
    asset: "VRSCTEST",
    amount: overrides.amount ?? "0.001",
    payer: PAYER,
    payTo: "explorerAPI@",
    requestId: REQUEST_ID,
    issuedAt: ISSUED_AT,
    ...(overrides.extensions !== undefined ? { extensions: overrides.extensions } : {}),
  });
}

function b64(text: string): string {
  return Buffer.from(text, "utf8").toString("base64");
}

describe("verify — stateless (POST /v1/verify semantics)", () => {
  it("verifies without writing any storage state and without checking balance", async () => {
    const { verifier, storage } = await setup(); // no balance at all
    const result = await verifier.verify(requestFor(), POLICY);
    expect(result).toEqual({ ok: true, requestId: REQUEST_ID, payer: PAYER_KEY, amountSats: 100_000n });
    expect(await storage.getSpentRequest(REQUEST_ID)).toBeUndefined(); // nothing burned
    // repeatable — stateless calls are not replays
    expect((await verifier.verify(requestFor(), POLICY)).ok).toBe(true);
  });

  it("returns the same pre-check errors as verifyAndReserve", async () => {
    const { verifier } = await setup();
    const result = await verifier.verify(requestFor({ amount: "0.002" }), POLICY);
    expect(!result.ok && result.error).toMatchObject({ httpStatus: 402, code: "price-mismatch" });
  });
});

describe("verifyAndReserve — happy paths", () => {
  it("verifies against the byte-exact canonical rebuild and reserves", async () => {
    const { verifier, storage, capturedCanonicals } = await setup({ balanceSats: 100_000n });
    const result = await verifier.verifyAndReserve(requestFor(), POLICY);
    expect(result).toEqual({
      ok: true,
      requestId: REQUEST_ID,
      payer: PAYER_KEY, // normalized balance-account key, not the as-signed casing
      amountSats: 100_000n,
      balanceAfterSats: 0n,
    });
    expect(capturedCanonicals).toEqual([expectedCanonical()]);
    expect((await storage.getSpentRequest(REQUEST_ID))?.status).toBe("reserved");
  });

  it("verifies against the LATEST identity state (checkLatest=true) so key rotation/revocation bite immediately", async () => {
    const { verifier, rpc } = await setup({ balanceSats: 100_000n });
    await verifier.verifyAndReserve(requestFor(), POLICY);
    const verifyCall = rpc.calls.find((c) => c.method === "verifyMessage");
    expect(verifyCall?.params[3]).toBe(true);
  });

  it("appends validated extensions verbatim to the canonical payload", async () => {
    const body = Buffer.from('{"query":"{ blocks }"}', "utf8");
    const fields: ExtensionField[] = [
      { key: "scheme.bodyHash", value: `sha256:${createHash("sha256").update(body).digest("hex")}` },
      { key: "x-mystartup.orderId", value: "ord_12345" },
    ];
    const { verifier, capturedCanonicals } = await setup({ balanceSats: 100_000n });
    const result = await verifier.verifyAndReserve(
      requestFor({ method: "POST", path: "/graphql", extensionsRaw: b64(serializeExtensionBlock(fields)), rawBody: body }),
      { priceHuman: "0.001", bodyHashPolicy: "required" },
    );
    expect(result.ok).toBe(true);
    expect(capturedCanonicals).toEqual([expectedCanonical({ method: "POST", path: "/graphql", extensions: fields })]);
  });

  it("accepts an explicit supported scheme version in the header", async () => {
    const { verifier } = await setup({ balanceSats: 100_000n });
    expect((await verifier.verifyAndReserve(requestFor({ scheme: "verus-prepaid-sig/0.1" }), POLICY)).ok).toBe(true);
  });

  it("accepts issuedAt exactly at the window boundary", async () => {
    const { verifier } = await setup({ balanceSats: 100_000n, now: ISSUED_AT + 300 });
    expect((await verifier.verifyAndReserve(requestFor(), POLICY)).ok).toBe(true);
  });
});

describe("verifyAndReserve — pre-checks (before any RPC)", () => {
  async function expectRejectedWithoutRpc(
    request: IncomingPaymentRequest,
    policy: RoutePolicy,
    code: string,
    httpStatus: number,
    setupOptions: Parameters<typeof setup>[0] = { balanceSats: 100_000n },
  ): Promise<Record<string, unknown> | undefined> {
    const { verifier, rpc } = await setup(setupOptions);
    const result = await verifier.verifyAndReserve(request, policy);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.error.code).toBe(code);
    expect(result.error.httpStatus).toBe(httpStatus);
    expect(rpc.calls).toHaveLength(0);
    return result.error.details;
  }

  it("missing header → 400 invalid-headers", async () => {
    await expectRejectedWithoutRpc(requestFor({ dropHeader: "x-v402-signature" }), POLICY, "invalid-headers", 400);
  });

  it("foreign scheme → 402 unsupported-scheme", async () => {
    await expectRejectedWithoutRpc(requestFor({ scheme: "evm-eip3009" }), POLICY, "unsupported-scheme", 402);
  });

  it("unknown scheme version → 400 unsupported-scheme-version (M2)", async () => {
    const details = await expectRejectedWithoutRpc(
      requestFor({ scheme: "verus-prepaid-sig/0.9" }),
      POLICY,
      "unsupported-scheme-version",
      400,
    );
    expect(details).toEqual({ supportedSchemeVersions: ["0.1"] });
  });

  it("amount mismatch → 402 price-mismatch with the current price (M6)", async () => {
    const details = await expectRejectedWithoutRpc(requestFor({ amount: "0.002" }), POLICY, "price-mismatch", 402);
    expect(details).toEqual({ currentPrice: "0.001" });
  });

  it("numerically-equal but byte-different amount is still a price mismatch", async () => {
    await expectRejectedWithoutRpc(requestFor({ amount: "0.0010" }), POLICY, "price-mismatch", 402);
  });

  it("timestamp one second past the window → 400", async () => {
    await expectRejectedWithoutRpc(requestFor(), POLICY, "timestamp-out-of-window", 400, {
      balanceSats: 100_000n,
      now: ISSUED_AT + 301,
    });
  });

  it("blocked identity → 403 without burning node capacity", async () => {
    await expectRejectedWithoutRpc(requestFor(), POLICY, "blocked", 403, { balanceSats: 100_000n, blocked: true });
  });

  it("path with dot-segments → 400 invalid-request (fail closed, M1)", async () => {
    await expectRejectedWithoutRpc(requestFor({ path: "/api/../secret" }), POLICY, "invalid-request", 400);
  });

  describe("extensions (B2)", () => {
    it("invalid base64 → 400 invalid-extensions", async () => {
      await expectRejectedWithoutRpc(requestFor({ extensionsRaw: "!!!" }), POLICY, "invalid-extensions", 400);
    });

    it("unsorted block → 400 invalid-extensions", async () => {
      const block = "x-a.b: 1\nscheme.bodyHash: sha256:00";
      await expectRejectedWithoutRpc(requestFor({ extensionsRaw: b64(block) }), POLICY, "invalid-extensions", 400);
    });

    it("oversized block → 400 extensions-too-large", async () => {
      const block = `x-big.data: ${"a".repeat(5000)}`;
      await expectRejectedWithoutRpc(requestFor({ extensionsRaw: b64(block) }), POLICY, "extensions-too-large", 400);
    });

    it("unknown scheme.* → 400 strict reject", async () => {
      const block = "scheme.futureField: x";
      await expectRejectedWithoutRpc(requestFor({ extensionsRaw: b64(block) }), POLICY, "unknown-scheme-extension", 400);
    });

    it("iana.* → 400 reserved until registered", async () => {
      const block = "iana.something: x";
      await expectRejectedWithoutRpc(requestFor({ extensionsRaw: b64(block) }), POLICY, "reserved-extension", 400);
    });

    it("required policy + body without bodyHash → 400 body-hash-required", async () => {
      await expectRejectedWithoutRpc(
        requestFor({ method: "POST", path: "/graphql", rawBody: Buffer.from("{}") }),
        { priceHuman: "0.001", bodyHashPolicy: "required" },
        "body-hash-required",
        400,
      );
    });

    it("bodyHash format violation → 400 invalid-body-hash", async () => {
      const block = "scheme.bodyHash: sha256:nothex";
      await expectRejectedWithoutRpc(
        requestFor({ method: "POST", extensionsRaw: b64(block), rawBody: Buffer.from("{}") }),
        POLICY,
        "invalid-body-hash",
        400,
      );
    });

    it("bodyHash mismatch → 400", async () => {
      const block = `scheme.bodyHash: sha256:${"0".repeat(64)}`;
      await expectRejectedWithoutRpc(
        requestFor({ method: "POST", extensionsRaw: b64(block), rawBody: Buffer.from("{}") }),
        POLICY,
        "body-hash-mismatch",
        400,
      );
    });

    it("policy ignored skips bodyHash verification but keeps the signed bytes", async () => {
      const fields: ExtensionField[] = [{ key: "scheme.bodyHash", value: `sha256:${"0".repeat(64)}` }];
      const { verifier, capturedCanonicals } = await setup({ balanceSats: 100_000n });
      const result = await verifier.verifyAndReserve(
        requestFor({ method: "POST", extensionsRaw: b64(serializeExtensionBlock(fields)), rawBody: Buffer.from("{}") }),
        { priceHuman: "0.001", bodyHashPolicy: "ignored" },
      );
      expect(result.ok).toBe(true);
      expect(capturedCanonicals[0]).toContain(`scheme.bodyHash: sha256:${"0".repeat(64)}`);
    });
  });
});

describe("verifyAndReserve — signature + reserve outcomes", () => {
  it("false from verifymessage → 402 invalid-signature", async () => {
    const { verifier } = await setup({ balanceSats: 100_000n, verifyMessage: async () => false });
    const result = await verifier.verifyAndReserve(requestFor(), POLICY);
    expect(!result.ok && result.error).toMatchObject({ httpStatus: 402, code: "invalid-signature" });
  });

  it("node unavailable → 503 verify-unavailable, nothing reserved (M5: retry same requestId)", async () => {
    const { verifier, storage } = await setup({
      balanceSats: 100_000n,
      verifyMessage: async () => {
        throw new VerusRpcUnavailableError("timeout", "getinfo: RPC timed out");
      },
    });
    const result = await verifier.verifyAndReserve(requestFor(), POLICY);
    expect(!result.ok && result.error).toMatchObject({ httpStatus: 503, code: "verify-unavailable" });
    expect(await storage.getSpentRequest(REQUEST_ID)).toBeUndefined();
  });

  it("daemon app error (e.g. unknown identity) → 402 invalid-signature", async () => {
    const { verifier } = await setup({
      balanceSats: 100_000n,
      verifyMessage: async () => {
        throw new VerusRpcError("verifymessage", -5, "Invalid identity");
      },
    });
    const result = await verifier.verifyAndReserve(requestFor(), POLICY);
    expect(!result.ok && result.error).toMatchObject({ httpStatus: 402, code: "invalid-signature" });
  });

  it("replayed requestId → 409 with previousStatus", async () => {
    const { verifier } = await setup({ balanceSats: 200_000n });
    await verifier.verifyAndReserve(requestFor(), POLICY);
    const result = await verifier.verifyAndReserve(requestFor(), POLICY);
    expect(!result.ok && result.error).toMatchObject({
      httpStatus: 409,
      code: "replay",
      details: { previousStatus: "reserved" },
    });
  });

  it("insufficient balance → 402 with balance + deposit hint", async () => {
    const { verifier } = await setup({ balanceSats: 10_000n });
    const result = await verifier.verifyAndReserve(requestFor(), POLICY);
    expect(!result.ok && result.error).toMatchObject({
      httpStatus: 402,
      code: "insufficient-balance",
      details: { balanceSats: "10000", requiredSats: "100000", depositAddress: "explorerAPI@" },
    });
  });

  it("unknown identity → 402 no-balance with deposit hint", async () => {
    const { verifier } = await setup();
    const result = await verifier.verifyAndReserve(requestFor(), POLICY);
    expect(!result.ok && result.error).toMatchObject({
      httpStatus: 402,
      code: "no-balance",
      details: { depositAddress: "explorerAPI@" },
    });
  });
});

describe("commit / rollback (B3, idempotent)", () => {
  it("commit is idempotent", async () => {
    const { verifier } = await setup({ balanceSats: 100_000n });
    await verifier.verifyAndReserve(requestFor(), POLICY);
    expect(await verifier.commit(REQUEST_ID, 42)).toEqual({ ok: true, alreadyCommitted: false, late: false });
    expect(await verifier.commit(REQUEST_ID, 42)).toEqual({ ok: true, alreadyCommitted: true, late: false });
  });

  it("commit after reaper refund → deterministic late commit with re-debit", async () => {
    const { verifier, storage } = await setup({ balanceSats: 100_000n });
    await verifier.verifyAndReserve(requestFor(), POLICY); // balance 0
    await storage.reapExpiredReservations(NOW + 1000, NOW + 1000); // refund → balance 100k
    const result = await verifier.commit(REQUEST_ID, 42);
    expect(result).toEqual({ ok: true, alreadyCommitted: false, late: true, balanceAfterSats: 0n });
    expect((await storage.getSpentRequest(REQUEST_ID))?.status).toBe("committed");
  });

  it("commit of an unknown requestId → 404", async () => {
    const { verifier } = await setup();
    const result = await verifier.commit("01UNKNOWNREQUESTIDXXXXXXXX", 0);
    expect(!result.ok && result.error).toMatchObject({ httpStatus: 404, code: "unknown-request" });
  });

  it("rollback refunds once and is idempotent; requestId stays burned", async () => {
    const { verifier, storage } = await setup({ balanceSats: 100_000n });
    await verifier.verifyAndReserve(requestFor(), POLICY);
    expect(await verifier.rollback(REQUEST_ID)).toEqual({ ok: true, alreadyRolledBack: false });
    expect(await verifier.rollback(REQUEST_ID)).toEqual({ ok: true, alreadyRolledBack: true });
    expect((await storage.getIdentity(PAYER_KEY))?.balanceSats).toBe(100_000n);
    const replay = await verifier.verifyAndReserve(requestFor(), POLICY);
    expect(!replay.ok && replay.error).toMatchObject({ code: "replay", details: { previousStatus: "error" } });
  });

  it("rollback after commit → 409 invalid-state", async () => {
    const { verifier } = await setup({ balanceSats: 100_000n });
    await verifier.verifyAndReserve(requestFor(), POLICY);
    await verifier.commit(REQUEST_ID, 1);
    const result = await verifier.rollback(REQUEST_ID);
    expect(!result.ok && result.error).toMatchObject({ httpStatus: 409, code: "invalid-state" });
  });
});
