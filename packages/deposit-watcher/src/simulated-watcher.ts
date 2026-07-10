import { randomUUID } from "node:crypto";
import { normalizeIdentityKey } from "@chainvue/v402-protocol";
import type { DepositRecord, IStorage } from "@chainvue/v402-storage";
import type { IWatcher, WatcherPollResult, WatcherStatus } from "./types.js";

export interface SimulatedWatcherConfig {
  currency: string;
  /** Recorded on simulated deposits so they look like credited real ones. Default 10. */
  minConfirmations?: number;
  /** Injectable for tests; defaults to process.env.NODE_ENV. */
  nodeEnv?: string;
  /** Injectable for tests; defaults to process.env.V402_ALLOW_SIMULATED_IN_PROD === "true". */
  allowInProduction?: boolean;
}

export interface SimulateDepositInput {
  identity: string;
  amountSats: bigint;
  txid?: string;
}

/**
 * Dev/CI watcher (plan § Deposit Watcher — Simulated Mode): no Verus RPC at
 * all; deposits are injected via `simulateDeposit` (wired to
 * POST /admin/simulate-deposit in the facilitator) and credited immediately.
 * Rows carry origin='simulated' — visible in logs and excluded from the
 * on-chain reconciliation crosscheck.
 */
export class SimulatedDepositWatcher implements IWatcher {
  readonly mode = "simulated" as const;

  private readonly storage: IStorage;
  private readonly config: { currency: string; minConfirmations: number };
  private readonly now: () => number;
  private running = false;
  private lastPollAt: number | undefined;
  private blockCounter = 1;

  constructor(deps: { storage: IStorage; config: SimulatedWatcherConfig; now?: () => number }) {
    const nodeEnv = deps.config.nodeEnv ?? process.env["NODE_ENV"];
    const allowInProduction =
      deps.config.allowInProduction ?? process.env["V402_ALLOW_SIMULATED_IN_PROD"] === "true";
    if (nodeEnv === "production" && !allowInProduction) {
      throw new Error(
        "SimulatedDepositWatcher refuses to run with NODE_ENV=production. " +
          "Set V402_ALLOW_SIMULATED_IN_PROD=true only if you really mean it — simulated deposits create spendable balance from nothing.",
      );
    }
    this.storage = deps.storage;
    this.config = { minConfirmations: 10, currency: deps.config.currency };
    if (deps.config.minConfirmations !== undefined) this.config.minConfirmations = deps.config.minConfirmations;
    this.now = deps.now ?? (() => Math.floor(Date.now() / 1000));
  }

  /** Insert + immediately credit a fake deposit. Returns the deposit row and the new balance. */
  async simulateDeposit(input: SimulateDepositInput): Promise<{ deposit: DepositRecord; balanceAfterSats: bigint }> {
    const txid = input.txid ?? `sim-${randomUUID()}`;
    const blockHeight = this.blockCounter++;
    const deposit = await this.storage.insertDeposit({
      identityId: normalizeIdentityKey(input.identity),
      amountSats: input.amountSats,
      currency: this.config.currency,
      txid,
      vout: 0,
      blockHeight,
      blockHash: `sim-${blockHeight}`,
      confirmations: this.config.minConfirmations,
      detectedAt: this.now(),
      origin: "simulated",
    });
    const credited = await this.storage.creditDeposit(deposit.id, this.now());
    if (!credited.ok) throw new Error(`simulated deposit could not be credited: ${credited.reason}`);
    return { deposit, balanceAfterSats: credited.balanceAfterSats };
  }

  start(): void {
    this.running = true;
  }

  async stop(): Promise<void> {
    this.running = false;
  }

  /** No chain to poll — kept for interface parity; reports current state only. */
  async pollOnce(): Promise<WatcherPollResult> {
    this.lastPollAt = this.now();
    return {
      bootstrapped: false,
      tip: this.blockCounter - 1,
      inserted: 0,
      remined: 0,
      reorged: 0,
      credited: [],
      unattributed: [],
      remainingBlocks: 0,
      opsFlags: [],
    };
  }

  status(): WatcherStatus {
    const status: WatcherStatus = { mode: this.mode, running: this.running, lagBlocks: 0 };
    if (this.lastPollAt !== undefined) status.lastPollAt = this.lastPollAt;
    return status;
  }
}
