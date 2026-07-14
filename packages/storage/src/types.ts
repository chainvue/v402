/**
 * Storage domain types. Amounts are ALWAYS bigint satoshis here (Q3);
 * converting to decimal strings is the job of the concrete backend (SQLite
 * stores TEXT) and of the HTTP boundary (human decimal strings).
 * Timestamps are Unix seconds and always passed in explicitly — storage never
 * reads the clock, which keeps implementations deterministic and testable.
 */

export interface IdentityRecord {
  identityId: string;
  balanceSats: bigint;
  createdAt: number;
  firstDepositAt?: number;
  lastRequestAt?: number;
}

export type SpentRequestStatus = "reserved" | "committed" | "error" | "insufficient" | "blocked" | "expired";

export interface SpentRequestRecord {
  requestId: string;
  identityId: string;
  issuedAt: number;
  receivedAt: number;
  amountSats: bigint;
  method: string;
  path: string;
  status: SpentRequestStatus;
  responseBytes?: number;
}

export type DepositOrigin = "real" | "simulated";

export interface DepositRecord {
  id: number;
  identityId: string;
  amountSats: bigint;
  currency: string;
  txid: string;
  vout: number;
  blockHeight: number;
  blockHash: string;
  confirmations: number;
  detectedAt: number;
  creditedAt?: number;
  reorgedAt?: number;
  origin: DepositOrigin;
  /** Operator attribution for manually minted deposits (/admin/credit, /admin/simulate-deposit). */
  createdBy?: string;
  /** Free-text operator note (e.g. support-case reference). */
  note?: string;
}

export type LedgerKind = "deposit" | "debit" | "refund" | "reorg_adjust";
export type LedgerReason = "reserve" | "commit" | "late_commit" | "rollback" | "reaper_expired" | "deposit_credited" | "reorg";

export interface LedgerEntry {
  id: number;
  identityId: string;
  kind: LedgerKind;
  reason: LedgerReason;
  /** Signed: +credit / −debit. */
  amountSats: bigint;
  requestId?: string;
  depositId?: number;
  balanceAfterSats: bigint;
  createdAt: number;
}

export interface BlockedIdentityRecord {
  identityId: string;
  reason?: string;
  blockedAt: number;
  blockedBy?: string;
}

export interface WatcherCursor {
  lastBlock: number;
  lastBlockHash: string;
  updatedAt: number;
}

export interface ReconciliationRun {
  id: number;
  runAt: number;
  identitiesChecked: number;
  mismatches: number;
  detailJson?: string;
  durationMs: number;
}

// ── Operation inputs / results ───────────────────────────────────────────────

export interface ReservePaymentInput {
  requestId: string;
  identityId: string;
  issuedAt: number;
  receivedAt: number;
  amountSats: bigint;
  method: string;
  path: string;
}

/**
 * Outcome of the atomic phase-1 debit. `replay` carries the previous status
 * for the 409 body. `insufficient` and `unknown-identity` still burn the
 * requestId (row persisted with status `insufficient`) — retrying after a
 * top-up requires a fresh ULID, matching the client retry table (M5).
 */
export type ReservePaymentResult =
  | { status: "reserved"; balanceAfterSats: bigint }
  | { status: "replay"; previousStatus: SpentRequestStatus }
  | { status: "insufficient"; balanceSats: bigint }
  | { status: "unknown-identity" };

/** Strictly conditional phase-2 transitions (B3): `ok: false` reports the actual current status. */
export type ConditionalUpdateResult = { ok: true } | { ok: false; currentStatus: SpentRequestStatus | undefined };

export type LateCommitResult =
  | { ok: true; balanceAfterSats: bigint }
  | { ok: false; currentStatus: SpentRequestStatus | undefined };

export interface RecordBalanceQueryInput {
  requestId: string;
  identityId: string;
  issuedAt: number;
  receivedAt: number;
  method: string;
  path: string;
}

export type RecordBalanceQueryResult =
  | { status: "recorded" }
  | { status: "replay"; previousStatus: SpentRequestStatus };

export interface InsertDepositInput {
  identityId: string;
  amountSats: bigint;
  currency: string;
  txid: string;
  vout: number;
  blockHeight: number;
  blockHash: string;
  confirmations: number;
  detectedAt: number;
  origin: DepositOrigin;
  /** Operator attribution for manually minted deposits. */
  createdBy?: string;
  /** Free-text operator note. */
  note?: string;
}

export type CreditDepositResult =
  | { ok: true; balanceAfterSats: bigint; identityCreated: boolean }
  | { ok: false; reason: "not-found" | "already-credited" | "reorged" };

/** Result of the atomic insert-and-credit used by the admin mint paths. */
export interface InsertAndCreditResult {
  deposit: DepositRecord;
  balanceAfterSats: bigint;
  identityCreated: boolean;
}

export type MarkReorgedResult =
  | { ok: true; wasCredited: boolean; balanceAfterSats?: bigint }
  | { ok: false; reason: "not-found" | "already-reorged" };

export interface LedgerSummary {
  entryCount: number;
  sumSats: bigint;
  latestBalanceAfterSats?: bigint;
}

export class StorageError extends Error {
  readonly code: "duplicate-deposit";

  constructor(code: "duplicate-deposit", message: string) {
    super(message);
    this.name = "StorageError";
    this.code = code;
  }
}
