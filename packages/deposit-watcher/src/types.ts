export type WatcherMode = "real" | "simulated";

export type UnattributedReason = "no-identity-vin" | "multiple-identities";

/** Outcome of one poll cycle — the facilitator logs/metrics these fields. */
export interface WatcherPollResult {
  /** True when this poll only initialized the cursor (first run). */
  bootstrapped: boolean;
  tip: number;
  scannedFrom?: number;
  scannedTo?: number;
  inserted: number;
  remined: number;
  reorged: number;
  credited: Array<{ depositId: number; identityId: string; balanceAfterSats: bigint }>;
  /** Outputs paying us that could not be auto-credited — manual reconciliation list (plan § Attribution rules). */
  unattributed: Array<{ txid: string; vout: number; reason: UnattributedReason }>;
  /** Blocks left above scannedTo when maxBlocksPerPoll capped the scan (never silently dropped). */
  remainingBlocks: number;
  /** Operational alerts: negative balances after reorg, deep-reorg warnings, … */
  opsFlags: string[];
}

export interface WatcherStatus {
  mode: WatcherMode;
  running: boolean;
  lastPollAt?: number;
  /** tip − cursor at the end of the last poll (alerting: plan risk "watcher lag > 5 min"). */
  lagBlocks?: number;
  lastError?: string;
}

/**
 * Common surface of both watcher implementations (plan § Deposit Watcher —
 * Real & Simulated Modes). `pollOnce` is the testable unit; `start` just
 * schedules it on the configured interval.
 */
export interface IWatcher {
  readonly mode: WatcherMode;
  start(): void;
  stop(): Promise<void>;
  pollOnce(): Promise<WatcherPollResult>;
  status(): WatcherStatus;
}
