/**
 * Integration test against a real VRSCTEST node — gated behind VERUS_RPC_URL
 * (same pattern as the verus-rpc suite).
 *
 * Fixture: historical on-chain deposit at height 1054312 —
 * tx b3470f76… vout 0 pays 500 VRSCTEST to ownora-nft@
 * (i713y8RkyAhfWZrreBgUq8tG9J5SxqCbRX), funded by a vin of the SAME identity
 * (single-identity attribution) whose daemon record carries no vin.address,
 * so the source-tx lookup path is exercised. Deeply confirmed → stable
 * fixture forever on this chain.
 */
import { describe, expect, it } from "vitest";
import { InMemoryStorage } from "@chainvue/v402-storage";
import { VerusRpcClient } from "@chainvue/v402-verus-rpc";
import { RealDepositWatcher } from "../src/index.js";

const RPC_URL = process.env["VERUS_RPC_URL"];

const FIXTURE = {
  txid: "b3470f76364adf56a28c4d6631b25c9bbad6299407abd3afe901050d43434190",
  vout: 0,
  blockHeight: 1_054_312,
  identityKey: "ownora-nft@",
  amountSats: 50_000_000_000n,
};

describe.skipIf(!RPC_URL)("deposit-watcher integration (VRSCTEST)", () => {
  it("detects, attributes and credits the historical identity deposit", async () => {
    const storage = new InMemoryStorage();
    await storage.initialize();
    const rpc = new VerusRpcClient({
      rpcUrl: RPC_URL ?? "",
      rpcUser: process.env["VERUS_RPC_USER"] ?? "",
      rpcPass: process.env["VERUS_RPC_PASS"] ?? "",
      circuit: { timeoutMs: 15_000 },
    });
    const watcher = new RealDepositWatcher({
      rpc,
      storage,
      config: {
        payToIdentity: "ownora-nft@",
        chainName: "VRSCTEST",
        currency: "VRSCTEST",
        minConfirmations: 10,
        startHeight: FIXTURE.blockHeight,
        maxBlocksPerPoll: 1, // scan exactly the fixture block
      },
    });

    const result = await watcher.pollOnce();
    expect(result.scannedFrom).toBe(FIXTURE.blockHeight);
    expect(result.scannedTo).toBe(FIXTURE.blockHeight);
    expect(result.inserted).toBe(1);
    // the same block carries a second payment to ownora-nft@ funded from
    // plain t-addresses — correctly refused and listed for manual reconciliation
    expect(result.unattributed).toEqual([
      { txid: "0b1d4035d8861e07ea8ed1834f00d84afdf881b99f717ac02ac045b146877cb9", vout: 0, reason: "no-identity-vin" },
    ]);
    // deeply confirmed → credited within the same poll's crediting pass
    expect(result.credited).toHaveLength(1);
    expect(result.credited[0]).toMatchObject({ identityId: FIXTURE.identityKey });

    const deposit = await storage.getDeposit(FIXTURE.txid, FIXTURE.vout);
    expect(deposit).toMatchObject({
      identityId: FIXTURE.identityKey,
      amountSats: FIXTURE.amountSats,
      blockHeight: FIXTURE.blockHeight,
      origin: "real",
    });
    expect(deposit?.creditedAt).toBeDefined();
    expect((await storage.getIdentity(FIXTURE.identityKey))?.balanceSats).toBe(FIXTURE.amountSats);

    const summary = await storage.getLedgerSummary(FIXTURE.identityKey);
    expect(summary.sumSats).toBe(FIXTURE.amountSats);
  }, 60_000);
});
