import { StorageError, type IStorage } from "@chainvue/v402-storage";
import type { IVerusRpc, VerusBlockVerbose } from "@chainvue/v402-verus-rpc";
import { attributeSender, emptyAttributionCaches } from "./attribution.js";
import type { IWatcher, WatcherPollResult, WatcherStatus } from "./types.js";

export interface RealWatcherConfig {
  /** Receiving identity (friendly name, e.g. "explorerAPI@"); resolved to its i-address on first poll. */
  payToIdentity: string;
  /** Native chain name for identity-name normalization, e.g. "VRSCTEST". */
  chainName: string;
  /** Currency recorded on deposits, e.g. "VRSCTEST". */
  currency: string;
  /** Poll interval. Default 15_000 (plan: Verus block time ~60s). */
  intervalMs?: number;
  /** Confirmation depth before crediting. Default 10. */
  minConfirmations?: number;
  /** How far the reorg rescan reaches below the cursor. Default 20. */
  reorgLookbackBlocks?: number;
  /** Cap per poll to bound RPC load on catch-up; remainder is reported, never dropped. Default 200. */
  maxBlocksPerPoll?: number;
  /** First block to scan on a fresh cursor. Default: bootstrap at the current tip (history ignored). */
  startHeight?: number;
}

export interface RealWatcherDeps {
  rpc: IVerusRpc;
  storage: IStorage;
  config: RealWatcherConfig;
  /** Unix-seconds clock, injectable for tests. */
  now?: () => number;
}

const CURSOR_KEY = "deposits";

/**
 * Production watcher (plan § Deposit Flow): polls the node, scans new blocks
 * for outputs paying the operator identity, attributes senders by VerusID,
 * tracks confirmations and credits at depth, detects reorgs via the
 * block-hash cursor and re-mines via upsert on (txid, vout) (M4).
 */
export class RealDepositWatcher implements IWatcher {
  readonly mode = "real" as const;

  private readonly rpc: IVerusRpc;
  private readonly storage: IStorage;
  private readonly config: Required<Omit<RealWatcherConfig, "startHeight">> & { startHeight?: number };
  private readonly now: () => number;

  private payToAddress: string | undefined;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private running = false;
  private polling = false;
  private lastPollAt: number | undefined;
  private lagBlocks: number | undefined;
  private lastError: string | undefined;

  constructor(deps: RealWatcherDeps) {
    this.rpc = deps.rpc;
    this.storage = deps.storage;
    this.config = {
      intervalMs: 15_000,
      minConfirmations: 10,
      reorgLookbackBlocks: 20,
      maxBlocksPerPoll: 200,
      ...deps.config,
    };
    this.now = deps.now ?? (() => Math.floor(Date.now() / 1000));
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    const tick = async (): Promise<void> => {
      if (!this.running) return;
      try {
        await this.pollOnce();
        this.lastError = undefined;
      } catch (err) {
        this.lastError = err instanceof Error ? err.message : String(err);
      }
      if (this.running) this.timer = setTimeout(() => void tick(), this.config.intervalMs);
    };
    this.timer = setTimeout(() => void tick(), 0);
  }

  async stop(): Promise<void> {
    this.running = false;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    // let an in-flight poll drain before reporting stopped
    while (this.polling) await new Promise((resolve) => setTimeout(resolve, 10));
  }

  status(): WatcherStatus {
    const status: WatcherStatus = { mode: this.mode, running: this.running };
    if (this.lastPollAt !== undefined) status.lastPollAt = this.lastPollAt;
    if (this.lagBlocks !== undefined) status.lagBlocks = this.lagBlocks;
    if (this.lastError !== undefined) status.lastError = this.lastError;
    return status;
  }

  async pollOnce(): Promise<WatcherPollResult> {
    this.polling = true;
    try {
      return await this.poll();
    } finally {
      this.polling = false;
      this.lastPollAt = this.now();
    }
  }

  private async resolvePayToAddress(): Promise<string> {
    if (this.payToAddress === undefined) {
      const result = await this.rpc.getIdentity(this.config.payToIdentity);
      this.payToAddress = result.identity.identityaddress;
    }
    return this.payToAddress;
  }

  private async poll(): Promise<WatcherPollResult> {
    const result: WatcherPollResult = {
      bootstrapped: false,
      tip: 0,
      inserted: 0,
      remined: 0,
      reorged: 0,
      credited: [],
      unattributed: [],
      remainingBlocks: 0,
      opsFlags: [],
    };
    const tip = await this.rpc.getBlockCount();
    result.tip = tip;
    const payToAddress = await this.resolvePayToAddress();

    let cursor = await this.storage.getWatcherCursor(CURSOR_KEY);
    if (!cursor) {
      const cursorHeight = this.config.startHeight !== undefined ? this.config.startHeight - 1 : tip;
      const block = await this.rpc.getBlock(cursorHeight);
      cursor = { lastBlock: cursorHeight, lastBlockHash: block.hash, updatedAt: this.now() };
      await this.storage.setWatcherCursor(CURSOR_KEY, cursor);
      result.bootstrapped = this.config.startHeight === undefined;
      if (result.bootstrapped) {
        this.lagBlocks = 0;
        return result;
      }
    }

    // Reorg check: does the chain still carry our cursor block?
    let scanFrom = cursor.lastBlock + 1;
    const cursorBlock = await this.rpc.getBlock(cursor.lastBlock);
    if (cursorBlock.hash !== cursor.lastBlockHash) {
      const lookbackFloor = Math.max(1, cursor.lastBlock - this.config.reorgLookbackBlocks);
      result.opsFlags.push(`reorg detected at cursor height ${cursor.lastBlock}; rescanning from ${lookbackFloor}`);
      const blockHashCache = new Map<number, string>();
      const hashAt = async (height: number): Promise<string> => {
        let hash = blockHashCache.get(height);
        if (hash === undefined) {
          hash = (await this.rpc.getBlock(height)).hash;
          blockHashCache.set(height, hash);
        }
        return hash;
      };
      // verify ALL recorded deposits — a reorg deeper than the lookback must alarm, not pass silently
      for (const deposit of await this.storage.listDepositsAtOrAbove(1)) {
        if (deposit.blockHash === (await hashAt(deposit.blockHeight))) continue;
        const marked = await this.storage.markDepositReorged(deposit.id, this.now());
        if (marked.ok) {
          result.reorged++;
          if (marked.wasCredited && marked.balanceAfterSats !== undefined && marked.balanceAfterSats < 0n) {
            result.opsFlags.push(
              `NEGATIVE BALANCE after reorg: ${deposit.identityId} at ${marked.balanceAfterSats} sats (deposit ${deposit.id})`,
            );
          }
          if (deposit.blockHeight < lookbackFloor) {
            result.opsFlags.push(`ALARM: reorg deeper than lookback window (deposit at height ${deposit.blockHeight})`);
          }
        }
      }
      scanFrom = lookbackFloor;
    }

    // Scan new (and rescanned) blocks
    const scanTo = Math.min(tip, scanFrom + this.config.maxBlocksPerPoll - 1);
    if (scanTo >= scanFrom) {
      result.scannedFrom = scanFrom;
      result.scannedTo = scanTo;
      const caches = emptyAttributionCaches();
      let lastScannedHash = "";
      for (let height = scanFrom; height <= scanTo; height++) {
        const block = await this.rpc.getBlockVerbose(height);
        lastScannedHash = block.hash;
        await this.scanBlock(block, height, tip, payToAddress, caches, result);
      }
      await this.storage.setWatcherCursor(CURSOR_KEY, {
        lastBlock: scanTo,
        lastBlockHash: lastScannedHash,
        updatedAt: this.now(),
      });
      result.remainingBlocks = tip - scanTo;
      if (result.remainingBlocks > 0) {
        result.opsFlags.push(`scan capped at ${this.config.maxBlocksPerPoll} blocks; ${result.remainingBlocks} remaining`);
      }
    }

    // Confirmation tracking + crediting at depth (plan: confirmations = tip − block_height)
    for (const deposit of await this.storage.listUncreditedDeposits()) {
      const confirmations = tip - deposit.blockHeight;
      await this.storage.updateDepositConfirmations(deposit.id, confirmations);
      if (confirmations >= this.config.minConfirmations) {
        const credited = await this.storage.creditDeposit(deposit.id, this.now());
        if (credited.ok) {
          result.credited.push({
            depositId: deposit.id,
            identityId: deposit.identityId,
            balanceAfterSats: credited.balanceAfterSats,
          });
        }
      }
    }

    this.lagBlocks = tip - Math.max(scanTo, cursor.lastBlock);
    return result;
  }

  private async scanBlock(
    block: VerusBlockVerbose,
    height: number,
    tip: number,
    payToAddress: string,
    caches: ReturnType<typeof emptyAttributionCaches>,
    result: WatcherPollResult,
  ): Promise<void> {
    for (const tx of block.tx) {
      for (const vout of tx.vout) {
        if (!(vout.scriptPubKey.addresses ?? []).includes(payToAddress)) continue;

        const existing = await this.storage.getDeposit(tx.txid, vout.n);
        if (existing) {
          // unchanged row seen again during a rescan overlap — leave it alone
          if (existing.blockHash === block.hash) continue;
          // M4 re-mine: same tx, new block position → back onto the normal credit path
          const remined = await this.storage.remineDeposit(tx.txid, vout.n, {
            blockHeight: height,
            blockHash: block.hash,
            confirmations: tip - height,
          });
          if (remined) result.remined++;
          continue;
        }

        const attribution = await attributeSender(tx, this.rpc, this.config.chainName, caches);
        if (!attribution.ok) {
          result.unattributed.push({ txid: tx.txid, vout: vout.n, reason: attribution.reason });
          continue;
        }

        // exact sats from the daemon when available (Q3); float fallback is defensive only
        const amountSats =
          vout.valueSat !== undefined ? BigInt(vout.valueSat) : BigInt(Math.round(vout.value * 100_000_000));
        try {
          await this.storage.insertDeposit({
            identityId: attribution.identityKey,
            amountSats,
            currency: this.config.currency,
            txid: tx.txid,
            vout: vout.n,
            blockHeight: height,
            blockHash: block.hash,
            confirmations: tip - height,
            detectedAt: this.now(),
            origin: "real",
          });
          result.inserted++;
        } catch (err) {
          // parallel writer already recorded it — benign
          if (!(err instanceof StorageError && err.code === "duplicate-deposit")) throw err;
        }
      }
    }
  }
}
