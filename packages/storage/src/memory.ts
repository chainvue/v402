import type { IStorage } from "./interface.js";
import {
  StorageError,
  type BlockedIdentityRecord,
  type ConditionalUpdateResult,
  type CreditDepositResult,
  type DepositRecord,
  type IdentityRecord,
  type InsertDepositInput,
  type LateCommitResult,
  type LedgerEntry,
  type LedgerKind,
  type LedgerReason,
  type LedgerSummary,
  type MarkReorgedResult,
  type RecordBalanceQueryInput,
  type RecordBalanceQueryResult,
  type ReconciliationRun,
  type ReservePaymentInput,
  type ReservePaymentResult,
  type SpentRequestRecord,
  type WatcherCursor,
} from "./types.js";

/**
 * Reference implementation for unit tests. Semantically equivalent to the
 * SQLite backend: same result unions, same ledger-per-balance-movement
 * contract, same conditional-transition behavior. JavaScript's single thread
 * plus fully synchronous bodies give the atomicity the interface demands.
 */
export class InMemoryStorage implements IStorage {
  private readonly identities = new Map<string, IdentityRecord>();
  private readonly spentRequests = new Map<string, SpentRequestRecord>();
  private readonly depositsByKey = new Map<string, DepositRecord>();
  private readonly ledger: LedgerEntry[] = [];
  private readonly blocked = new Map<string, BlockedIdentityRecord>();
  private readonly cursors = new Map<string, WatcherCursor>();
  private readonly reconciliationRuns: ReconciliationRun[] = [];
  private nextDepositId = 1;
  private nextLedgerId = 1;
  private nextReconciliationId = 1;

  async initialize(): Promise<void> {}

  async close(): Promise<void> {}

  private depositKey(txid: string, vout: number): string {
    return `${txid}:${vout}`;
  }

  private depositById(id: number): DepositRecord | undefined {
    for (const deposit of this.depositsByKey.values()) {
      if (deposit.id === id) return deposit;
    }
    return undefined;
  }

  private appendLedger(
    identityId: string,
    kind: LedgerKind,
    reason: LedgerReason,
    amountSats: bigint,
    balanceAfterSats: bigint,
    createdAt: number,
    refs: { requestId?: string; depositId?: number } = {},
  ): void {
    const entry: LedgerEntry = {
      id: this.nextLedgerId++,
      identityId,
      kind,
      reason,
      amountSats,
      balanceAfterSats,
      createdAt,
    };
    if (refs.requestId !== undefined) entry.requestId = refs.requestId;
    if (refs.depositId !== undefined) entry.depositId = refs.depositId;
    this.ledger.push(entry);
  }

  // ── Identities ──────────────────────────────────────────────────────────

  async getIdentity(identityId: string): Promise<IdentityRecord | undefined> {
    const identity = this.identities.get(identityId);
    return identity === undefined ? undefined : { ...identity };
  }

  async listIdentityIds(): Promise<string[]> {
    return [...this.identities.keys()];
  }

  // ── Two-phase debit ─────────────────────────────────────────────────────

  async reservePayment(input: ReservePaymentInput): Promise<ReservePaymentResult> {
    const existing = this.spentRequests.get(input.requestId);
    if (existing) return { status: "replay", previousStatus: existing.status };

    const row: SpentRequestRecord = {
      requestId: input.requestId,
      identityId: input.identityId,
      issuedAt: input.issuedAt,
      receivedAt: input.receivedAt,
      amountSats: input.amountSats,
      method: input.method,
      path: input.path,
      status: "reserved",
    };

    const identity = this.identities.get(input.identityId);
    if (!identity) {
      row.status = "insufficient";
      this.spentRequests.set(row.requestId, row);
      return { status: "unknown-identity" };
    }
    identity.lastRequestAt = input.receivedAt;
    if (identity.balanceSats < input.amountSats) {
      row.status = "insufficient";
      this.spentRequests.set(row.requestId, row);
      return { status: "insufficient", balanceSats: identity.balanceSats };
    }

    identity.balanceSats -= input.amountSats;
    this.spentRequests.set(row.requestId, row);
    this.appendLedger(input.identityId, "debit", "reserve", -input.amountSats, identity.balanceSats, input.receivedAt, {
      requestId: input.requestId,
    });
    return { status: "reserved", balanceAfterSats: identity.balanceSats };
  }

  async commitPayment(requestId: string, responseBytes: number, _at: number): Promise<ConditionalUpdateResult> {
    const row = this.spentRequests.get(requestId);
    if (!row || row.status !== "reserved") return { ok: false, currentStatus: row?.status };
    row.status = "committed";
    row.responseBytes = responseBytes;
    return { ok: true };
  }

  async rollbackPayment(requestId: string, at: number): Promise<ConditionalUpdateResult> {
    const row = this.spentRequests.get(requestId);
    if (!row || row.status !== "reserved") return { ok: false, currentStatus: row?.status };
    const identity = this.identities.get(row.identityId);
    if (!identity) return { ok: false, currentStatus: row.status };
    row.status = "error";
    identity.balanceSats += row.amountSats;
    this.appendLedger(row.identityId, "refund", "rollback", row.amountSats, identity.balanceSats, at, { requestId });
    return { ok: true };
  }

  async lateCommitPayment(requestId: string, responseBytes: number, at: number): Promise<LateCommitResult> {
    const row = this.spentRequests.get(requestId);
    if (!row || row.status !== "error") return { ok: false, currentStatus: row?.status };
    const identity = this.identities.get(row.identityId);
    if (!identity) return { ok: false, currentStatus: row.status };
    row.status = "committed";
    row.responseBytes = responseBytes;
    identity.balanceSats -= row.amountSats;
    this.appendLedger(row.identityId, "debit", "late_commit", -row.amountSats, identity.balanceSats, at, { requestId });
    return { ok: true, balanceAfterSats: identity.balanceSats };
  }

  async reapExpiredReservations(cutoffReceivedAt: number, at: number): Promise<string[]> {
    const reaped: string[] = [];
    for (const row of this.spentRequests.values()) {
      if (row.status !== "reserved" || row.receivedAt >= cutoffReceivedAt) continue;
      const identity = this.identities.get(row.identityId);
      if (!identity) continue;
      row.status = "error";
      identity.balanceSats += row.amountSats;
      this.appendLedger(row.identityId, "refund", "reaper_expired", row.amountSats, identity.balanceSats, at, {
        requestId: row.requestId,
      });
      reaped.push(row.requestId);
    }
    return reaped;
  }

  async cleanupSpentRequests(cutoffIssuedAt: number): Promise<number> {
    let removed = 0;
    for (const [requestId, row] of this.spentRequests) {
      if (row.issuedAt < cutoffIssuedAt) {
        this.spentRequests.delete(requestId);
        removed++;
      }
    }
    return removed;
  }

  async getSpentRequest(requestId: string): Promise<SpentRequestRecord | undefined> {
    const row = this.spentRequests.get(requestId);
    return row === undefined ? undefined : { ...row };
  }

  async recordBalanceQuery(input: RecordBalanceQueryInput): Promise<RecordBalanceQueryResult> {
    const existing = this.spentRequests.get(input.requestId);
    if (existing) return { status: "replay", previousStatus: existing.status };
    this.spentRequests.set(input.requestId, {
      requestId: input.requestId,
      identityId: input.identityId,
      issuedAt: input.issuedAt,
      receivedAt: input.receivedAt,
      amountSats: 0n,
      method: input.method,
      path: input.path,
      status: "committed",
    });
    return { status: "recorded" };
  }

  // ── Deposits ────────────────────────────────────────────────────────────

  async insertDeposit(input: InsertDepositInput): Promise<DepositRecord> {
    const key = this.depositKey(input.txid, input.vout);
    if (this.depositsByKey.has(key)) {
      throw new StorageError("duplicate-deposit", `deposit ${key} already exists — use remineDeposit for re-mines`);
    }
    const deposit: DepositRecord = { id: this.nextDepositId++, ...input };
    this.depositsByKey.set(key, deposit);
    return { ...deposit };
  }

  async getDeposit(txid: string, vout: number): Promise<DepositRecord | undefined> {
    const deposit = this.depositsByKey.get(this.depositKey(txid, vout));
    return deposit === undefined ? undefined : { ...deposit };
  }

  async remineDeposit(
    txid: string,
    vout: number,
    update: { blockHeight: number; blockHash: string; confirmations: number },
  ): Promise<DepositRecord | undefined> {
    const deposit = this.depositsByKey.get(this.depositKey(txid, vout));
    if (!deposit) return undefined;
    deposit.blockHeight = update.blockHeight;
    deposit.blockHash = update.blockHash;
    deposit.confirmations = update.confirmations;
    delete deposit.reorgedAt;
    delete deposit.creditedAt;
    return { ...deposit };
  }

  async updateDepositConfirmations(id: number, confirmations: number): Promise<void> {
    const deposit = this.depositById(id);
    if (deposit) deposit.confirmations = confirmations;
  }

  async listUncreditedDeposits(): Promise<DepositRecord[]> {
    return [...this.depositsByKey.values()]
      .filter((d) => d.creditedAt === undefined && d.reorgedAt === undefined)
      .map((d) => ({ ...d }));
  }

  async creditDeposit(id: number, creditedAt: number): Promise<CreditDepositResult> {
    const deposit = this.depositById(id);
    if (!deposit) return { ok: false, reason: "not-found" };
    if (deposit.reorgedAt !== undefined) return { ok: false, reason: "reorged" };
    if (deposit.creditedAt !== undefined) return { ok: false, reason: "already-credited" };

    deposit.creditedAt = creditedAt;
    let identity = this.identities.get(deposit.identityId);
    const identityCreated = identity === undefined;
    if (!identity) {
      identity = { identityId: deposit.identityId, balanceSats: 0n, createdAt: creditedAt, firstDepositAt: creditedAt };
      this.identities.set(deposit.identityId, identity);
    } else if (identity.firstDepositAt === undefined) {
      identity.firstDepositAt = creditedAt;
    }
    identity.balanceSats += deposit.amountSats;
    this.appendLedger(deposit.identityId, "deposit", "deposit_credited", deposit.amountSats, identity.balanceSats, creditedAt, {
      depositId: deposit.id,
    });
    return { ok: true, balanceAfterSats: identity.balanceSats, identityCreated };
  }

  async markDepositReorged(id: number, reorgedAt: number): Promise<MarkReorgedResult> {
    const deposit = this.depositById(id);
    if (!deposit) return { ok: false, reason: "not-found" };
    if (deposit.reorgedAt !== undefined) return { ok: false, reason: "already-reorged" };

    const wasCredited = deposit.creditedAt !== undefined;
    deposit.reorgedAt = reorgedAt;
    if (!wasCredited) return { ok: true, wasCredited: false };

    const identity = this.identities.get(deposit.identityId);
    if (!identity) return { ok: true, wasCredited: false };
    identity.balanceSats -= deposit.amountSats;
    this.appendLedger(deposit.identityId, "reorg_adjust", "reorg", -deposit.amountSats, identity.balanceSats, reorgedAt, {
      depositId: deposit.id,
    });
    return { ok: true, wasCredited: true, balanceAfterSats: identity.balanceSats };
  }

  // ── Ledger ──────────────────────────────────────────────────────────────

  async listLedgerEntries(identityId: string, options?: { afterId?: number; limit?: number }): Promise<LedgerEntry[]> {
    const afterId = options?.afterId ?? 0;
    const entries = this.ledger.filter((e) => e.identityId === identityId && e.id > afterId).map((e) => ({ ...e }));
    return options?.limit !== undefined ? entries.slice(0, options.limit) : entries;
  }

  async getLedgerSummary(identityId: string): Promise<LedgerSummary> {
    let sumSats = 0n;
    let latest: LedgerEntry | undefined;
    let entryCount = 0;
    for (const entry of this.ledger) {
      if (entry.identityId !== identityId) continue;
      sumSats += entry.amountSats;
      latest = entry;
      entryCount++;
    }
    const summary: LedgerSummary = { entryCount, sumSats };
    if (latest !== undefined) summary.latestBalanceAfterSats = latest.balanceAfterSats;
    return summary;
  }

  async sumCreditedDeposits(options?: { excludeSimulated?: boolean }): Promise<bigint> {
    let sum = 0n;
    for (const deposit of this.depositsByKey.values()) {
      if (deposit.creditedAt === undefined || deposit.reorgedAt !== undefined) continue;
      if (options?.excludeSimulated === true && deposit.origin === "simulated") continue;
      sum += deposit.amountSats;
    }
    return sum;
  }

  // ── Blocklist ───────────────────────────────────────────────────────────

  async isBlocked(identityId: string): Promise<boolean> {
    return this.blocked.has(identityId);
  }

  async blockIdentity(record: BlockedIdentityRecord): Promise<void> {
    this.blocked.set(record.identityId, { ...record });
  }

  async unblockIdentity(identityId: string): Promise<boolean> {
    return this.blocked.delete(identityId);
  }

  async listBlockedIdentities(): Promise<BlockedIdentityRecord[]> {
    return [...this.blocked.values()].map((r) => ({ ...r }));
  }

  // ── Watcher cursor ──────────────────────────────────────────────────────

  async getWatcherCursor(key: string): Promise<WatcherCursor | undefined> {
    const cursor = this.cursors.get(key);
    return cursor === undefined ? undefined : { ...cursor };
  }

  async setWatcherCursor(key: string, cursor: WatcherCursor): Promise<void> {
    this.cursors.set(key, { ...cursor });
  }

  // ── Reconciliation log ──────────────────────────────────────────────────

  async recordReconciliationRun(run: Omit<ReconciliationRun, "id">): Promise<ReconciliationRun> {
    const record: ReconciliationRun = { id: this.nextReconciliationId++, ...run };
    this.reconciliationRuns.push(record);
    return { ...record };
  }

  async listReconciliationRuns(limit = 50): Promise<ReconciliationRun[]> {
    return this.reconciliationRuns.slice(-limit).reverse().map((r) => ({ ...r }));
  }
}
