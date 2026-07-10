import { describe, expect, it } from "vitest";
import { InMemoryStorage } from "@chainvue/v402-storage";
import { MockVerusRpc, type VerusIdentityResult, type VerusRawTransaction } from "@chainvue/v402-verus-rpc";
import { RealDepositWatcher } from "../src/index.js";

const PAY_TO_ADDR = "iPayToIdentityAddress000000000000";
const SENDER_ADDR = "iSenderIdentityAddress00000000000";
const SENDER2_ADDR = "iSecondIdentityAddress00000000000";
const T_ADDR = "RPlainTransparentAddress000000000";
const T0 = 1_783_650_000;

interface FakeBlock {
  hash: string;
  height: number;
  time: number;
  tx: VerusRawTransaction[];
}

function identityResult(name: string, address: string): VerusIdentityResult {
  return {
    identity: {
      name,
      identityaddress: address,
      parent: "iChain",
      systemid: "iChain",
      primaryaddresses: ["RPrimary"],
      minimumsignatures: 1,
      revocationauthority: address,
      recoveryauthority: address,
      flags: 0,
      version: 3,
      timelock: 0,
    },
    status: "active",
    blockheight: 1,
    fullyqualifiedname: `${name}.VRSCTEST@`,
  };
}

/** Minimal chain double: blocks by height, source txs for vin lookups, identity directory. */
class FakeChain {
  readonly blocks = new Map<number, FakeBlock>();
  readonly sourceTxs = new Map<string, VerusRawTransaction>();
  readonly identities = new Map<string, VerusIdentityResult>([
    ["explorerAPI@", identityResult("explorerAPI", PAY_TO_ADDR)],
    [PAY_TO_ADDR, identityResult("explorerAPI", PAY_TO_ADDR)],
    [SENDER_ADDR, identityResult("demoAgent", SENDER_ADDR)],
    [SENDER2_ADDR, identityResult("otherAgent", SENDER2_ADDR)],
  ]);
  tip = 0;

  constructor() {
    this.addBlock(0); // genesis — real chains have block 0, cursor bootstrap may reference it
  }

  addBlock(height: number, tx: VerusRawTransaction[] = [], variant = "a"): void {
    this.blocks.set(height, { hash: `h${height}-${variant}`, height, time: T0 + height, tx });
    this.tip = Math.max(this.tip, height);
  }

  addSourceTx(txid: string, addresses: string[]): void {
    this.sourceTxs.set(txid, {
      txid,
      vin: [],
      vout: [{ value: 1, valueSat: 100_000_000, n: 0, scriptPubKey: { addresses } }],
    });
  }

  rpc(): MockVerusRpc {
    return new MockVerusRpc({
      getBlockCount: async () => this.tip,
      getBlock: async (h) => {
        const block = this.blocks.get(Number(h));
        if (!block) throw new Error(`no block at ${h}`);
        return { ...block, tx: block.tx.map((t) => t.txid) };
      },
      getBlockVerbose: async (h) => {
        const block = this.blocks.get(Number(h));
        if (!block) throw new Error(`no block at ${h}`);
        return { ...block };
      },
      getRawTransaction: async (txid) => {
        const tx = this.sourceTxs.get(txid);
        if (!tx) throw new Error(`no tx ${txid}`);
        return tx;
      },
      getIdentity: async (nameOrAddress) => {
        const identity = this.identities.get(nameOrAddress);
        if (!identity) throw new Error(`no identity ${nameOrAddress}`);
        return identity;
      },
    });
  }
}

/** Payment of `valueSat` to the operator identity, funded from the given vins. */
function paymentTx(
  txid: string,
  vins: Array<{ srcTxid: string; vout?: number } | { address: string } | { coinbase: true }>,
  valueSat = 50_000,
): VerusRawTransaction {
  return {
    txid,
    vin: vins.map((v) => {
      if ("coinbase" in v) return { coinbase: "03abc" };
      if ("address" in v) return { address: v.address };
      return { txid: v.srcTxid, vout: v.vout ?? 0 };
    }),
    vout: [{ value: valueSat / 1e8, valueSat, n: 0, scriptPubKey: { addresses: [PAY_TO_ADDR] } }],
  };
}

async function makeWatcher(chain: FakeChain, config: Partial<Parameters<typeof watcherConfig>[0]> = {}) {
  const storage = new InMemoryStorage();
  await storage.initialize();
  const rpc = chain.rpc();
  const watcher = new RealDepositWatcher({
    rpc,
    storage,
    config: watcherConfig(config),
    now: () => T0,
  });
  return { watcher, storage, rpc };
}

function watcherConfig(overrides: {
  minConfirmations?: number;
  startHeight?: number;
  maxBlocksPerPoll?: number;
  reorgLookbackBlocks?: number;
}) {
  return {
    payToIdentity: "explorerAPI@",
    chainName: "VRSCTEST",
    currency: "VRSCTEST",
    minConfirmations: 2,
    reorgLookbackBlocks: 5,
    intervalMs: 5,
    ...overrides,
  };
}

describe("RealDepositWatcher — scanning + attribution", () => {
  it("bootstraps the cursor at the tip and ignores history", async () => {
    const chain = new FakeChain();
    for (let h = 1; h <= 5; h++) chain.addBlock(h, h === 3 ? [paymentTx("old", [{ address: SENDER_ADDR }])] : []);
    const { watcher, storage } = await makeWatcher(chain);
    const result = await watcher.pollOnce();
    expect(result.bootstrapped).toBe(true);
    expect(result.inserted).toBe(0);
    expect(await storage.getWatcherCursor("deposits")).toMatchObject({ lastBlock: 5, lastBlockHash: "h5-a" });
    // next poll: nothing new
    expect((await watcher.pollOnce()).scannedFrom).toBeUndefined();
  });

  it("detects a deposit, attributes the normalized sender identity, credits at depth", async () => {
    const chain = new FakeChain();
    chain.addSourceTx("src1", [SENDER_ADDR]);
    for (let h = 1; h <= 8; h++) chain.addBlock(h);
    chain.addBlock(9, [paymentTx("dep1", [{ srcTxid: "src1" }])]);
    chain.addBlock(10);
    const { watcher, storage } = await makeWatcher(chain, { startHeight: 9 });

    const first = await watcher.pollOnce(); // tip 10 → 1 confirmation, below depth 2
    expect(first.inserted).toBe(1);
    expect(first.credited).toEqual([]);
    expect((await storage.getDeposit("dep1", 0))?.identityId).toBe("demoagent@");

    chain.addBlock(11);
    const second = await watcher.pollOnce(); // 2 confirmations → credit
    expect(second.credited).toEqual([{ depositId: 1, identityId: "demoagent@", balanceAfterSats: 50_000n }]);
    expect((await storage.getIdentity("demoagent@"))?.balanceSats).toBe(50_000n);
    expect(watcher.status().lagBlocks).toBe(0);
  });

  it("uses vin.address directly when the daemon provides it (no source-tx fetch)", async () => {
    const chain = new FakeChain();
    for (let h = 1; h <= 9; h++) chain.addBlock(h);
    chain.addBlock(10, [paymentTx("dep1", [{ address: SENDER_ADDR }])]);
    const { watcher, rpc } = await makeWatcher(chain, { startHeight: 10 });
    expect((await watcher.pollOnce()).inserted).toBe(1);
    expect(rpc.calls.filter((c) => c.method === "getRawTransaction")).toHaveLength(0);
  });

  it("accepts multiple vins from the SAME identity", async () => {
    const chain = new FakeChain();
    chain.addSourceTx("srcA", [SENDER_ADDR]);
    chain.addSourceTx("srcB", [SENDER_ADDR, T_ADDR]); // t-addr change input alongside is fine
    for (let h = 1; h <= 9; h++) chain.addBlock(h);
    chain.addBlock(10, [paymentTx("dep1", [{ srcTxid: "srcA" }, { srcTxid: "srcB" }])]);
    const { watcher } = await makeWatcher(chain, { startHeight: 10 });
    expect((await watcher.pollOnce()).inserted).toBe(1);
  });

  it("refuses attribution across DIFFERENT identities (manual reconciliation)", async () => {
    const chain = new FakeChain();
    chain.addSourceTx("srcA", [SENDER_ADDR]);
    chain.addSourceTx("srcB", [SENDER2_ADDR]);
    for (let h = 1; h <= 9; h++) chain.addBlock(h);
    chain.addBlock(10, [paymentTx("dep1", [{ srcTxid: "srcA" }, { srcTxid: "srcB" }])]);
    const { watcher, storage } = await makeWatcher(chain, { startHeight: 10 });
    const result = await watcher.pollOnce();
    expect(result.inserted).toBe(0);
    expect(result.unattributed).toEqual([{ txid: "dep1", vout: 0, reason: "multiple-identities" }]);
    expect(await storage.getDeposit("dep1", 0)).toBeUndefined();
  });

  it("refuses plain t-address senders and coinbase payouts", async () => {
    const chain = new FakeChain();
    chain.addSourceTx("srcT", [T_ADDR]);
    for (let h = 1; h <= 9; h++) chain.addBlock(h);
    chain.addBlock(10, [
      paymentTx("tOnly", [{ srcTxid: "srcT" }]),
      paymentTx("coinbase", [{ coinbase: true }]),
    ]);
    const { watcher } = await makeWatcher(chain, { startHeight: 10 });
    const result = await watcher.pollOnce();
    expect(result.inserted).toBe(0);
    expect(result.unattributed.map((u) => u.reason)).toEqual(["no-identity-vin", "no-identity-vin"]);
  });

  it("caps blocks per poll, reports the remainder, and catches up next poll", async () => {
    const chain = new FakeChain();
    chain.addSourceTx("src1", [SENDER_ADDR]);
    for (let h = 1; h <= 10; h++) chain.addBlock(h, h === 7 ? [paymentTx("dep7", [{ srcTxid: "src1" }])] : []);
    const { watcher } = await makeWatcher(chain, { startHeight: 1, maxBlocksPerPoll: 3 });

    const first = await watcher.pollOnce();
    expect([first.scannedFrom, first.scannedTo, first.remainingBlocks]).toEqual([1, 3, 7]);
    expect(first.opsFlags.join()).toContain("capped");

    const second = await watcher.pollOnce();
    expect([second.scannedFrom, second.scannedTo]).toEqual([4, 6]);
    const third = await watcher.pollOnce();
    expect(third.inserted).toBe(1); // block 7 reached
  });
});

describe("RealDepositWatcher — reorg handling (M4)", () => {
  async function creditedDepositAt9(chain: FakeChain) {
    chain.addSourceTx("src1", [SENDER_ADDR]);
    for (let h = 1; h <= 8; h++) chain.addBlock(h);
    chain.addBlock(9, [paymentTx("dep1", [{ srcTxid: "src1" }])]);
    chain.addBlock(10);
    chain.addBlock(11);
    const made = await makeWatcher(chain, { startHeight: 9 });
    await made.watcher.pollOnce(); // insert + credit (tip 11 → 2 confirmations)
    expect((await made.storage.getIdentity("demoagent@"))?.balanceSats).toBe(50_000n);
    return made;
  }

  it("marks reorged deposits, re-mines them in the replacement branch, credits again", async () => {
    const chain = new FakeChain();
    const { watcher, storage } = await creditedDepositAt9(chain);

    // reorg: blocks 9–11 replaced; the tx re-mines at height 10
    chain.addBlock(9, [], "b");
    chain.addBlock(10, [paymentTx("dep1", [{ srcTxid: "src1" }])], "b");
    chain.addBlock(11, [], "b");
    chain.addBlock(12, [], "b");

    const result = await watcher.pollOnce();
    expect(result.reorged).toBe(1);
    expect(result.remined).toBe(1);
    expect(result.credited).toEqual([{ depositId: 1, identityId: "demoagent@", balanceAfterSats: 50_000n }]); // tip 12 − height 10 = 2
    const deposit = await storage.getDeposit("dep1", 0);
    expect(deposit?.blockHeight).toBe(10);
    expect(deposit?.reorgedAt).toBeUndefined();
    // full audit trail: deposit → reorg_adjust → deposit
    expect((await storage.listLedgerEntries("demoagent@")).map((e) => e.kind)).toEqual([
      "deposit",
      "reorg_adjust",
      "deposit",
    ]);
  });

  it("flags negative balances when a reorg pulls already-spent money", async () => {
    const chain = new FakeChain();
    const { watcher, storage } = await creditedDepositAt9(chain);
    await storage.reservePayment({
      requestId: "01H8XG7Q4M2N8P5R7T3V9WXYZA",
      identityId: "demoagent@",
      issuedAt: T0,
      receivedAt: T0,
      amountSats: 40_000n,
      method: "GET",
      path: "/x",
    });
    // reorg drops the deposit entirely (not re-mined)
    chain.addBlock(9, [], "b");
    chain.addBlock(10, [], "b");
    chain.addBlock(11, [], "b");

    const result = await watcher.pollOnce();
    expect(result.reorged).toBe(1);
    expect(result.opsFlags.join()).toContain("NEGATIVE BALANCE");
    expect((await storage.getIdentity("demoagent@"))?.balanceSats).toBe(-40_000n);
  });

  it("leaves untouched deposits alone during a rescan overlap", async () => {
    const chain = new FakeChain();
    const { watcher, storage } = await creditedDepositAt9(chain);
    // only block 11 is replaced; block 9 (with our credited deposit) is untouched
    chain.addBlock(11, [], "b");
    chain.addBlock(12, [], "b");

    const result = await watcher.pollOnce();
    expect(result.reorged).toBe(0);
    expect(result.remined).toBe(0);
    const deposit = await storage.getDeposit("dep1", 0);
    expect(deposit?.creditedAt).toBeDefined();
    expect((await storage.listLedgerEntries("demoagent@")).map((e) => e.kind)).toEqual(["deposit"]);
  });
});

describe("RealDepositWatcher — lifecycle", () => {
  it("start schedules polls, stop halts them", async () => {
    const chain = new FakeChain();
    chain.addBlock(1);
    const { watcher } = await makeWatcher(chain);
    watcher.start();
    await new Promise((resolve) => setTimeout(resolve, 30));
    await watcher.stop();
    const status = watcher.status();
    expect(status.running).toBe(false);
    expect(status.lastPollAt).toBe(T0);
  });
});
