import { describe, expect, it } from "vitest";
import { canonicalize } from "@chainvue/v402-protocol";
import { decodeWif, signIdentityMessage } from "@chainvue/v402-signer-verus";
import { InMemoryStorage } from "@chainvue/v402-storage";
import {
  MockVerusRpc,
  VerusRpcError,
  VerusRpcUnavailableError,
  type VerusIdentityResult,
} from "@chainvue/v402-verus-rpc";
import {
  CachedIdentityProvider,
  VerusPrepaidSigVerifier,
  type IncomingPaymentRequest,
  type RoutePolicy,
} from "../src/index.js";

/**
 * Offline verification mode: real signatures (published test key A) over the
 * byte-exact canonical rebuild, verified by local pubkey recovery against
 * mocked getidentity state — no verifyMessage RPC anywhere.
 */

const PAYER = "v402test.demoAgent@";
const PAYER_KEY = "v402test.demoagent@";
const REQUEST_ID = "01H8XG7Q4M2N8P5R7T3V9WXYZA";
const ISSUED_AT = 1_783_650_000;
const NOW = ISSUED_AT + 5;
const POLICY: RoutePolicy = { priceHuman: "0.001", bodyHashPolicy: "optional" };

// Published vector facts: key A/B, the v402test@ i-address, VRSCTEST system id.
const KEY_A_WIF = "Uw81VDAH8zrvbGJLfo1nfLaWN9tnGMo2U3bB81Zg8MKBvakrNXqP";
const KEY_A_ADDRESS = "RXzn488JQaeEpo7iezaKiK1XLfRQzi2NWT";
const KEY_B_ADDRESS = "RLjrXPziU4Moc13vc2vGMvNpMmfM7ozZir";
const IDENTITY_ADDRESS = "iGnQaDzEcrFWg3J9Jg5MqPKCwo52Din4Ma";
const SYSTEM_ID = "iJhCezBExJHvtyH3fGhNnt2NhU4Ztkf2yq";
const SIGN_HEIGHT = 1_141_245;

function canonical(): string {
  return canonicalize({
    scheme: "verus-prepaid-sig",
    schemeVersion: "0.1",
    canonicalDomain: "explorer.example.com",
    method: "GET",
    path: "/api/tx/abc",
    network: "vrsctest",
    asset: "VRSCTEST",
    amount: "0.001",
    payer: PAYER,
    payTo: "explorerAPI@",
    requestId: REQUEST_ID,
    issuedAt: ISSUED_AT,
  });
}

function signCanonical(): string {
  return signIdentityMessage(canonical(), decodeWif(KEY_A_WIF), {
    blockHeight: SIGN_HEIGHT,
    systemId: SYSTEM_ID,
    identityAddress: IDENTITY_ADDRESS,
  });
}

function identityResult(overrides: { primaryaddresses?: string[]; minimumsignatures?: number; status?: string } = {}): VerusIdentityResult {
  return {
    identity: {
      name: "demoAgent",
      identityaddress: IDENTITY_ADDRESS,
      parent: "iGnQaDzEcrFWg3J9Jg5MqPKCwo52Din4Ma",
      systemid: SYSTEM_ID,
      primaryaddresses: overrides.primaryaddresses ?? [KEY_A_ADDRESS],
      minimumsignatures: overrides.minimumsignatures ?? 1,
      revocationauthority: IDENTITY_ADDRESS,
      recoveryauthority: IDENTITY_ADDRESS,
      flags: 0,
      version: 3,
      timelock: 0,
    },
    status: overrides.status ?? "active",
    blockheight: SIGN_HEIGHT,
  };
}

function requestFor(signature: string): IncomingPaymentRequest {
  return {
    method: "GET",
    path: "/api/tx/abc",
    headers: {
      "x-v402-scheme": "verus-prepaid-sig",
      "x-v402-payer": PAYER,
      "x-v402-amount": "0.001",
      "x-v402-request-id": REQUEST_ID,
      "x-v402-issued-at": String(ISSUED_AT),
      "x-v402-signature": signature,
    },
  };
}

async function setup(options: {
  getIdentity?: (nameOrAddress: string) => Promise<VerusIdentityResult>;
  providerNow?: () => number;
} = {}) {
  const storage = new InMemoryStorage();
  await storage.initialize();
  const deposit = await storage.insertDeposit({
    identityId: PAYER_KEY,
    amountSats: 100_000n,
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
  const rpc = new MockVerusRpc({
    getIdentity: options.getIdentity ?? (async () => identityResult()),
  });
  const provider = new CachedIdentityProvider(rpc, { now: options.providerNow ?? (() => NOW) });
  const verifier = new VerusPrepaidSigVerifier({
    storage,
    rpc,
    identityProvider: provider,
    config: {
      network: "vrsctest",
      asset: "VRSCTEST",
      payTo: "explorerAPI@",
      canonicalDomain: "explorer.example.com",
      verificationMode: "offline",
    },
    now: () => NOW,
  });
  return { verifier, storage, rpc, provider };
}

describe("offline verification mode", () => {
  it("accepts a real identity signature without any verifyMessage RPC", async () => {
    const { verifier, rpc } = await setup();
    const result = await verifier.verifyAndReserve(requestFor(signCanonical()), POLICY);
    expect(result).toMatchObject({ ok: true, requestId: REQUEST_ID, payer: PAYER_KEY });
    expect(rpc.calls.filter((c) => c.method === "verifyMessage")).toHaveLength(0);
    expect(rpc.calls.filter((c) => c.method === "getIdentity")).toHaveLength(1);
  });

  it("serves repeated verifications from the identity cache", async () => {
    const { verifier, rpc } = await setup();
    expect((await verifier.verify(requestFor(signCanonical()), POLICY)).ok).toBe(true);
    expect((await verifier.verify(requestFor(signCanonical()), POLICY)).ok).toBe(true);
    expect(rpc.calls.filter((c) => c.method === "getIdentity")).toHaveLength(1);
  });

  it("rejects a tampered signature without refetching within the refresh guard", async () => {
    const { verifier, rpc } = await setup();
    const tampered = signCanonical().replace(/.{4}$/, "AAAA");
    const result = await verifier.verify(requestFor(tampered), POLICY);
    expect(!result.ok && result.error).toMatchObject({ httpStatus: 402, code: "invalid-signature" });
    // initial fetch only — the immediate refresh is rate-limited (same state, same verdict)
    expect(rpc.calls.filter((c) => c.method === "getIdentity")).toHaveLength(1);
  });

  it("self-heals after key rotation: stale cache fails, refresh verifies", async () => {
    let call = 0;
    let clock = NOW;
    const { verifier, rpc } = await setup({
      // first getidentity: rotated-away state (key B only); afterwards: key A
      getIdentity: async () => identityResult({ primaryaddresses: [++call === 1 ? KEY_B_ADDRESS : KEY_A_ADDRESS] }),
      providerNow: () => clock,
    });
    // warm the cache with the stale state, then age it past the refresh guard
    const cold = await verifier.verify(requestFor(signCanonical()), POLICY);
    expect(!cold.ok && cold.error.code).toBe("invalid-signature");
    clock = NOW + 10;
    const healed = await verifier.verify(requestFor(signCanonical()), POLICY);
    expect(healed.ok).toBe(true);
    expect(rpc.calls.filter((c) => c.method === "getIdentity")).toHaveLength(2);
  });

  it("rejects revoked identities", async () => {
    const { verifier } = await setup({ getIdentity: async () => identityResult({ status: "revoked" }) });
    const result = await verifier.verify(requestFor(signCanonical()), POLICY);
    expect(!result.ok && result.error).toMatchObject({ httpStatus: 402, code: "invalid-signature" });
  });

  it("maps an unreachable node to verify-unavailable 503 (M5 same-id retry)", async () => {
    const { verifier } = await setup({
      getIdentity: async () => {
        throw new VerusRpcUnavailableError("timeout", "node down");
      },
    });
    const result = await verifier.verify(requestFor(signCanonical()), POLICY);
    expect(!result.ok && result.error).toMatchObject({ httpStatus: 503, code: "verify-unavailable" });
  });

  it("maps an unknown identity (daemon app error) to invalid-signature", async () => {
    const { verifier } = await setup({
      getIdentity: async () => {
        throw new VerusRpcError("getidentity", -5, "Identity not found");
      },
    });
    const result = await verifier.verify(requestFor(signCanonical()), POLICY);
    expect(!result.ok && result.error).toMatchObject({ httpStatus: 402, code: "invalid-signature" });
  });
});

describe("CachedIdentityProvider", () => {
  it("caches within the TTL and refetches after expiry", async () => {
    let clock = 1000;
    const rpc = new MockVerusRpc({ getIdentity: async () => identityResult() });
    const provider = new CachedIdentityProvider(rpc, { ttlSec: 60, now: () => clock });
    await provider.getIdentityState(PAYER);
    clock = 1059;
    await provider.getIdentityState(PAYER);
    expect(rpc.calls.filter((c) => c.method === "getIdentity")).toHaveLength(1);
    clock = 1061;
    await provider.getIdentityState(PAYER);
    expect(rpc.calls.filter((c) => c.method === "getIdentity")).toHaveLength(2);
  });

  it("normalizes the cache key (case-insensitive identities)", async () => {
    const rpc = new MockVerusRpc({ getIdentity: async () => identityResult() });
    const provider = new CachedIdentityProvider(rpc, { now: () => 1000 });
    await provider.getIdentityState("v402test.demoAgent@");
    await provider.getIdentityState("V402TEST.DEMOAGENT@");
    expect(rpc.calls.filter((c) => c.method === "getIdentity")).toHaveLength(1);
  });

  it("deduplicates concurrent lookups into one RPC", async () => {
    let resolveIt: ((r: VerusIdentityResult) => void) | undefined;
    const rpc = new MockVerusRpc({
      getIdentity: () => new Promise<VerusIdentityResult>((resolve) => (resolveIt = resolve)),
    });
    const provider = new CachedIdentityProvider(rpc, { now: () => 1000 });
    const [a, b] = [provider.getIdentityState(PAYER), provider.getIdentityState(PAYER)];
    resolveIt!(identityResult());
    expect((await a).primaryAddresses).toEqual([KEY_A_ADDRESS]);
    expect((await b).primaryAddresses).toEqual([KEY_A_ADDRESS]);
    expect(rpc.calls.filter((c) => c.method === "getIdentity")).toHaveLength(1);
  });

  it("does not cache failures", async () => {
    let fail = true;
    const rpc = new MockVerusRpc({
      getIdentity: async () => {
        if (fail) throw new VerusRpcUnavailableError("timeout", "node down");
        return identityResult();
      },
    });
    const provider = new CachedIdentityProvider(rpc, { now: () => 1000 });
    await expect(provider.getIdentityState(PAYER)).rejects.toThrow();
    fail = false;
    expect((await provider.getIdentityState(PAYER)).revoked).toBe(false);
  });

  it("rate-limits refreshes below minRefreshAgeSec", async () => {
    let clock = 1000;
    const rpc = new MockVerusRpc({ getIdentity: async () => identityResult() });
    const provider = new CachedIdentityProvider(rpc, { minRefreshAgeSec: 5, now: () => clock });
    const first = await provider.getIdentityState(PAYER);
    clock = 1004;
    expect(await provider.refreshIdentityState(PAYER)).toBe(first); // same object — guarded
    clock = 1006;
    await provider.refreshIdentityState(PAYER);
    expect(rpc.calls.filter((c) => c.method === "getIdentity")).toHaveLength(2);
  });

  it("reports hit/miss/refresh/refresh_suppressed to the observability hook", async () => {
    let clock = 1000;
    const events: string[] = [];
    const rpc = new MockVerusRpc({ getIdentity: async () => identityResult() });
    const provider = new CachedIdentityProvider(rpc, {
      ttlSec: 60,
      minRefreshAgeSec: 5,
      now: () => clock,
      onEvent: (event) => events.push(event),
    });
    await provider.getIdentityState(PAYER); // cold -> miss
    await provider.getIdentityState(PAYER); // fresh -> hit
    clock = 1002;
    await provider.refreshIdentityState(PAYER); // young entry -> suppressed
    clock = 1006;
    await provider.refreshIdentityState(PAYER); // past guard -> refresh
    clock = 1100;
    await provider.getIdentityState(PAYER); // TTL expired -> miss
    expect(events).toEqual(["miss", "hit", "refresh_suppressed", "refresh", "miss"]);
  });

  it("a throwing observability hook never breaks lookups", async () => {
    const rpc = new MockVerusRpc({ getIdentity: async () => identityResult() });
    const provider = new CachedIdentityProvider(rpc, {
      now: () => 1000,
      onEvent: () => {
        throw new Error("metrics backend down");
      },
    });
    expect((await provider.getIdentityState(PAYER)).revoked).toBe(false);
    expect((await provider.refreshIdentityState(PAYER)).revoked).toBe(false);
  });
});
