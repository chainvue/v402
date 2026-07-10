import type {
  BlockedIdentityRecord,
  ConditionalUpdateResult,
  CreditDepositResult,
  DepositRecord,
  IdentityRecord,
  InsertDepositInput,
  LateCommitResult,
  LedgerEntry,
  LedgerSummary,
  MarkReorgedResult,
  RecordBalanceQueryInput,
  RecordBalanceQueryResult,
  ReconciliationRun,
  ReservePaymentInput,
  ReservePaymentResult,
  SpentRequestRecord,
  WatcherCursor,
} from "./types.js";

/**
 * Persistence boundary of the facilitator. Implementations: `InMemoryStorage`
 * (this package, tests) and `@chainvue/v402-storage-sqlite` (production).
 *
 * The multi-step operations (reserve/commit/rollback/credit/reorg/reap) are
 * ATOMIC by contract — the implementation must apply the spent-request
 * transition, the balance movement, and the ledger append in one transaction
 * (SQLite: one BEGIN IMMEDIATE). Every balance movement writes exactly one
 * ledger row (B1); the ledger is the append-only source of truth for
 * reconciliation, `spent_requests` is short-lived replay state only.
 */
export interface IStorage {
  initialize(): Promise<void>;
  close(): Promise<void>;

  // ── Identities ────────────────────────────────────────────────────────────
  getIdentity(identityId: string): Promise<IdentityRecord | undefined>;
  /** All identity ids — reconciliation iterates these. */
  listIdentityIds(): Promise<string[]>;

  // ── Two-phase debit (spec § Two-phase debit) ─────────────────────────────
  /**
   * Phase 1: burn requestId (replay protection), lock + check balance,
   * decrement, ledger `debit/reserve`, update `last_request_at`.
   */
  reservePayment(input: ReservePaymentInput): Promise<ReservePaymentResult>;
  /** Phase 2 on 2xx: `reserved → committed`, record responseBytes. Balance already moved in phase 1. */
  commitPayment(requestId: string, responseBytes: number, at: number): Promise<ConditionalUpdateResult>;
  /** Phase 2 on 5xx: `reserved → error`, refund, ledger `refund/rollback`. RequestId stays burned. */
  rollbackPayment(requestId: string, at: number): Promise<ConditionalUpdateResult>;
  /**
   * B3 late commit: a 2xx landed after the reaper refunded (`status = error`).
   * Re-debit (`debit/late_commit`), mark committed. Balance MAY go negative —
   * the caller flags that for ops.
   */
  lateCommitPayment(requestId: string, responseBytes: number, at: number): Promise<LateCommitResult>;
  /**
   * Reaper: refund every `reserved` request with `receivedAt < cutoff`
   * (ledger `refund/reaper_expired`, status → error). Returns the requestIds.
   */
  reapExpiredReservations(cutoffReceivedAt: number, at: number): Promise<string[]>;
  /** Replay-retention cleanup: delete rows with `issuedAt < cutoff`. Returns count. */
  cleanupSpentRequests(cutoffIssuedAt: number): Promise<number>;
  getSpentRequest(requestId: string): Promise<SpentRequestRecord | undefined>;
  /** Sum of currently reserved amounts for an identity — the balance endpoint's `reserved` figure. */
  sumReservedSats(identityId: string): Promise<bigint>;
  /** Replay-protected signed balance query — row with amount 0, immediately committed. */
  recordBalanceQuery(input: RecordBalanceQueryInput): Promise<RecordBalanceQueryResult>;

  // ── Deposits (spec § Deposit flow, M4) ───────────────────────────────────
  /** Throws StorageError("duplicate-deposit") on an existing (txid, vout) — use remineDeposit for reorg re-mines. */
  insertDeposit(input: InsertDepositInput): Promise<DepositRecord>;
  getDeposit(txid: string, vout: number): Promise<DepositRecord | undefined>;
  /**
   * M4 re-mine upsert on (txid, vout): new block position, `reorged_at`
   * cleared, confirmations reset, `credited_at = null` — crediting then
   * follows the normal confirmation path again.
   */
  remineDeposit(
    txid: string,
    vout: number,
    update: { blockHeight: number; blockHash: string; confirmations: number },
  ): Promise<DepositRecord | undefined>;
  updateDepositConfirmations(id: number, confirmations: number): Promise<void>;
  /** Deposits awaiting confirmation depth (`credited_at` null, not reorged). */
  listUncreditedDeposits(): Promise<DepositRecord[]>;
  /** Non-reorged deposits with `blockHeight >= height` — the watcher's reorg check scans these. */
  listDepositsAtOrAbove(blockHeight: number): Promise<DepositRecord[]>;
  /**
   * Credit a confirmed deposit: set `credited_at`, auto-provision the identity
   * on first deposit, balance += amount, ledger `deposit/deposit_credited`.
   */
  creditDeposit(id: number, creditedAt: number): Promise<CreditDepositResult>;
  /**
   * Reorg: mark `reorged_at`; when it was credited, balance −= amount with
   * ledger `reorg_adjust/reorg`. Balance MAY go negative — caller flags ops.
   */
  markDepositReorged(id: number, reorgedAt: number): Promise<MarkReorgedResult>;

  // ── Ledger (B1 — append happens inside the atomic ops above) ────────────
  listLedgerEntries(identityId: string, options?: { afterId?: number; limit?: number }): Promise<LedgerEntry[]>;
  /** Reconciliation invariants: `balance == sumSats` and `balance == latestBalanceAfterSats`. */
  getLedgerSummary(identityId: string): Promise<LedgerSummary>;
  /** Facility-wide credited deposit sum for the on-chain crosscheck; simulated rows excludable. */
  sumCreditedDeposits(options?: { excludeSimulated?: boolean }): Promise<bigint>;

  // ── Blocklist ─────────────────────────────────────────────────────────────
  isBlocked(identityId: string): Promise<boolean>;
  blockIdentity(record: BlockedIdentityRecord): Promise<void>;
  unblockIdentity(identityId: string): Promise<boolean>;
  listBlockedIdentities(): Promise<BlockedIdentityRecord[]>;

  // ── Watcher cursor ────────────────────────────────────────────────────────
  getWatcherCursor(key: string): Promise<WatcherCursor | undefined>;
  setWatcherCursor(key: string, cursor: WatcherCursor): Promise<void>;

  // ── Reconciliation log ────────────────────────────────────────────────────
  recordReconciliationRun(run: Omit<ReconciliationRun, "id">): Promise<ReconciliationRun>;
  listReconciliationRuns(limit?: number): Promise<ReconciliationRun[]>;
}
