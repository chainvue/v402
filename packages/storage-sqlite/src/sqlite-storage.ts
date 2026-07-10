import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { and, asc, desc, eq, gt, gte, isNull, lt, ne } from "drizzle-orm";
import { drizzle, type BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import {
  StorageError,
  type BlockedIdentityRecord,
  type ConditionalUpdateResult,
  type CreditDepositResult,
  type DepositOrigin,
  type DepositRecord,
  type IStorage,
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
  type SpentRequestStatus,
  type WatcherCursor,
} from "@chainvue/v402-storage";
import {
  blockedIdentities,
  deposits,
  identities,
  ledgerEntries,
  reconciliationLog,
  spentRequests,
  watcherCursor,
} from "./schema.js";

export interface SqliteStorageConfig {
  /** File path or ":memory:". Parent directories are created on initialize. */
  path: string;
  /** WAL journal mode (plan default). Default true. */
  walMode?: boolean;
  /** busy_timeout for cross-process writer contention. Default 5000ms. */
  busyTimeoutMs?: number;
}

function isUniqueViolation(err: unknown): boolean {
  return err instanceof Error && "code" in err && String((err as { code: unknown }).code).startsWith("SQLITE_CONSTRAINT");
}

type Tx = Parameters<Parameters<BetterSQLite3Database["transaction"]>[0]>[0];

/**
 * SQLite-backed IStorage. Every composite operation runs in one
 * BEGIN IMMEDIATE transaction — SQLite's single-writer lock is the
 * concurrency model (plan § Payment Flow: DB-wide write lock, not row locks).
 */
export class SqliteStorage implements IStorage {
  private readonly config: Required<SqliteStorageConfig>;
  private sqlite: Database.Database | undefined;
  private db: BetterSQLite3Database | undefined;

  constructor(config: SqliteStorageConfig) {
    this.config = { walMode: true, busyTimeoutMs: 5000, ...config };
  }

  async initialize(): Promise<void> {
    if (this.db) return;
    if (this.config.path !== ":memory:") {
      mkdirSync(dirname(this.config.path), { recursive: true });
    }
    this.sqlite = new Database(this.config.path);
    this.sqlite.pragma(`busy_timeout = ${this.config.busyTimeoutMs}`);
    if (this.config.walMode && this.config.path !== ":memory:") {
      this.sqlite.pragma("journal_mode = WAL");
      this.sqlite.pragma("synchronous = NORMAL");
    }
    this.db = drizzle(this.sqlite);
    migrate(this.db, { migrationsFolder: fileURLToPath(new URL("../migrations", import.meta.url)) });
  }

  async close(): Promise<void> {
    this.sqlite?.close();
    this.sqlite = undefined;
    this.db = undefined;
  }

  private use(): BetterSQLite3Database {
    if (!this.db) throw new Error("SqliteStorage not initialized — call initialize() first");
    return this.db;
  }

  private writeTx<T>(fn: (tx: Tx) => T): T {
    return this.use().transaction(fn, { behavior: "immediate" });
  }

  private appendLedger(
    tx: Tx,
    identityId: string,
    kind: LedgerKind,
    reason: LedgerReason,
    amountSats: bigint,
    balanceAfterSats: bigint,
    createdAt: number,
    refs: { requestId?: string; depositId?: number } = {},
  ): void {
    tx.insert(ledgerEntries)
      .values({
        identityId,
        kind,
        reason,
        amount: amountSats.toString(),
        requestId: refs.requestId ?? null,
        depositId: refs.depositId ?? null,
        balanceAfter: balanceAfterSats.toString(),
        createdAt,
      })
      .run();
  }

  // ── Row mapping ─────────────────────────────────────────────────────────

  private mapIdentity(row: typeof identities.$inferSelect): IdentityRecord {
    const record: IdentityRecord = {
      identityId: row.identityId,
      balanceSats: BigInt(row.balance),
      createdAt: row.createdAt,
    };
    if (row.firstDepositAt !== null) record.firstDepositAt = row.firstDepositAt;
    if (row.lastRequestAt !== null) record.lastRequestAt = row.lastRequestAt;
    return record;
  }

  private mapSpentRequest(row: typeof spentRequests.$inferSelect): SpentRequestRecord {
    const record: SpentRequestRecord = {
      requestId: row.requestId,
      identityId: row.identityId,
      issuedAt: row.issuedAt,
      receivedAt: row.receivedAt,
      amountSats: BigInt(row.amount),
      method: row.method,
      path: row.path,
      status: row.status as SpentRequestStatus,
    };
    if (row.responseBytes !== null) record.responseBytes = row.responseBytes;
    return record;
  }

  private mapDeposit(row: typeof deposits.$inferSelect): DepositRecord {
    const record: DepositRecord = {
      id: row.id,
      identityId: row.identityId,
      amountSats: BigInt(row.amount),
      currency: row.currency,
      txid: row.txid,
      vout: row.vout,
      blockHeight: row.blockHeight,
      blockHash: row.blockHash,
      confirmations: row.confirmations,
      detectedAt: row.detectedAt,
      origin: row.origin as DepositOrigin,
    };
    if (row.creditedAt !== null) record.creditedAt = row.creditedAt;
    if (row.reorgedAt !== null) record.reorgedAt = row.reorgedAt;
    return record;
  }

  private mapLedgerEntry(row: typeof ledgerEntries.$inferSelect): LedgerEntry {
    const record: LedgerEntry = {
      id: row.id,
      identityId: row.identityId,
      kind: row.kind as LedgerKind,
      reason: row.reason as LedgerReason,
      amountSats: BigInt(row.amount),
      balanceAfterSats: BigInt(row.balanceAfter),
      createdAt: row.createdAt,
    };
    if (row.requestId !== null) record.requestId = row.requestId;
    if (row.depositId !== null) record.depositId = row.depositId;
    return record;
  }

  // ── Identities ──────────────────────────────────────────────────────────

  async getIdentity(identityId: string): Promise<IdentityRecord | undefined> {
    const row = this.use().select().from(identities).where(eq(identities.identityId, identityId)).get();
    return row ? this.mapIdentity(row) : undefined;
  }

  async listIdentityIds(): Promise<string[]> {
    return this.use()
      .select({ identityId: identities.identityId })
      .from(identities)
      .all()
      .map((r) => r.identityId);
  }

  // ── Two-phase debit ─────────────────────────────────────────────────────

  async reservePayment(input: ReservePaymentInput): Promise<ReservePaymentResult> {
    try {
      return this.writeTx((tx): ReservePaymentResult => {
        const existing = tx.select().from(spentRequests).where(eq(spentRequests.requestId, input.requestId)).get();
        if (existing) return { status: "replay", previousStatus: existing.status as SpentRequestStatus };

        const insertRow = (status: SpentRequestStatus): void => {
          tx.insert(spentRequests)
            .values({
              requestId: input.requestId,
              identityId: input.identityId,
              issuedAt: input.issuedAt,
              amount: input.amountSats.toString(),
              receivedAt: input.receivedAt,
              method: input.method,
              path: input.path,
              status,
            })
            .run();
        };

        const identityRow = tx.select().from(identities).where(eq(identities.identityId, input.identityId)).get();
        if (!identityRow) {
          insertRow("insufficient");
          return { status: "unknown-identity" };
        }

        const balance = BigInt(identityRow.balance);
        if (balance < input.amountSats) {
          insertRow("insufficient");
          tx.update(identities)
            .set({ lastRequestAt: input.receivedAt })
            .where(eq(identities.identityId, input.identityId))
            .run();
          return { status: "insufficient", balanceSats: balance };
        }

        const balanceAfter = balance - input.amountSats;
        insertRow("reserved");
        tx.update(identities)
          .set({ balance: balanceAfter.toString(), lastRequestAt: input.receivedAt })
          .where(eq(identities.identityId, input.identityId))
          .run();
        this.appendLedger(tx, input.identityId, "debit", "reserve", -input.amountSats, balanceAfter, input.receivedAt, {
          requestId: input.requestId,
        });
        return { status: "reserved", balanceAfterSats: balanceAfter };
      });
    } catch (err) {
      // cross-process race on the requestId PK: the concurrent writer won — report replay
      if (isUniqueViolation(err)) {
        const row = await this.getSpentRequest(input.requestId);
        if (row) return { status: "replay", previousStatus: row.status };
      }
      throw err;
    }
  }

  async commitPayment(requestId: string, responseBytes: number, _at: number): Promise<ConditionalUpdateResult> {
    return this.writeTx((tx): ConditionalUpdateResult => {
      const row = tx.select().from(spentRequests).where(eq(spentRequests.requestId, requestId)).get();
      if (!row || row.status !== "reserved") {
        return { ok: false, currentStatus: row ? (row.status as SpentRequestStatus) : undefined };
      }
      tx.update(spentRequests)
        .set({ status: "committed", responseBytes })
        .where(and(eq(spentRequests.requestId, requestId), eq(spentRequests.status, "reserved")))
        .run();
      return { ok: true };
    });
  }

  async rollbackPayment(requestId: string, at: number): Promise<ConditionalUpdateResult> {
    return this.writeTx((tx): ConditionalUpdateResult => {
      const row = tx.select().from(spentRequests).where(eq(spentRequests.requestId, requestId)).get();
      if (!row || row.status !== "reserved") {
        return { ok: false, currentStatus: row ? (row.status as SpentRequestStatus) : undefined };
      }
      const identityRow = tx.select().from(identities).where(eq(identities.identityId, row.identityId)).get();
      if (!identityRow) return { ok: false, currentStatus: row.status as SpentRequestStatus };

      const balanceAfter = BigInt(identityRow.balance) + BigInt(row.amount);
      tx.update(spentRequests).set({ status: "error" }).where(eq(spentRequests.requestId, requestId)).run();
      tx.update(identities)
        .set({ balance: balanceAfter.toString() })
        .where(eq(identities.identityId, row.identityId))
        .run();
      this.appendLedger(tx, row.identityId, "refund", "rollback", BigInt(row.amount), balanceAfter, at, { requestId });
      return { ok: true };
    });
  }

  async lateCommitPayment(requestId: string, responseBytes: number, at: number): Promise<LateCommitResult> {
    return this.writeTx((tx): LateCommitResult => {
      const row = tx.select().from(spentRequests).where(eq(spentRequests.requestId, requestId)).get();
      if (!row || row.status !== "error") {
        return { ok: false, currentStatus: row ? (row.status as SpentRequestStatus) : undefined };
      }
      const identityRow = tx.select().from(identities).where(eq(identities.identityId, row.identityId)).get();
      if (!identityRow) return { ok: false, currentStatus: row.status as SpentRequestStatus };

      const balanceAfter = BigInt(identityRow.balance) - BigInt(row.amount);
      tx.update(spentRequests).set({ status: "committed", responseBytes }).where(eq(spentRequests.requestId, requestId)).run();
      tx.update(identities)
        .set({ balance: balanceAfter.toString() })
        .where(eq(identities.identityId, row.identityId))
        .run();
      this.appendLedger(tx, row.identityId, "debit", "late_commit", -BigInt(row.amount), balanceAfter, at, { requestId });
      return { ok: true, balanceAfterSats: balanceAfter };
    });
  }

  async reapExpiredReservations(cutoffReceivedAt: number, at: number): Promise<string[]> {
    return this.writeTx((tx): string[] => {
      const expired = tx
        .select()
        .from(spentRequests)
        .where(and(eq(spentRequests.status, "reserved"), lt(spentRequests.receivedAt, cutoffReceivedAt)))
        .all();
      const reaped: string[] = [];
      for (const row of expired) {
        const identityRow = tx.select().from(identities).where(eq(identities.identityId, row.identityId)).get();
        if (!identityRow) continue;
        const balanceAfter = BigInt(identityRow.balance) + BigInt(row.amount);
        tx.update(spentRequests).set({ status: "error" }).where(eq(spentRequests.requestId, row.requestId)).run();
        tx.update(identities)
          .set({ balance: balanceAfter.toString() })
          .where(eq(identities.identityId, row.identityId))
          .run();
        this.appendLedger(tx, row.identityId, "refund", "reaper_expired", BigInt(row.amount), balanceAfter, at, {
          requestId: row.requestId,
        });
        reaped.push(row.requestId);
      }
      return reaped;
    });
  }

  async cleanupSpentRequests(cutoffIssuedAt: number): Promise<number> {
    return this.use().delete(spentRequests).where(lt(spentRequests.issuedAt, cutoffIssuedAt)).run().changes;
  }

  async getSpentRequest(requestId: string): Promise<SpentRequestRecord | undefined> {
    const row = this.use().select().from(spentRequests).where(eq(spentRequests.requestId, requestId)).get();
    return row ? this.mapSpentRequest(row) : undefined;
  }

  async sumReservedSats(identityId: string): Promise<bigint> {
    const rows = this.use()
      .select({ amount: spentRequests.amount })
      .from(spentRequests)
      .where(and(eq(spentRequests.identityId, identityId), eq(spentRequests.status, "reserved")))
      .all();
    let sum = 0n;
    for (const row of rows) sum += BigInt(row.amount);
    return sum;
  }

  async recordBalanceQuery(input: RecordBalanceQueryInput): Promise<RecordBalanceQueryResult> {
    try {
      return this.writeTx((tx): RecordBalanceQueryResult => {
        const existing = tx.select().from(spentRequests).where(eq(spentRequests.requestId, input.requestId)).get();
        if (existing) return { status: "replay", previousStatus: existing.status as SpentRequestStatus };
        tx.insert(spentRequests)
          .values({
            requestId: input.requestId,
            identityId: input.identityId,
            issuedAt: input.issuedAt,
            amount: "0",
            receivedAt: input.receivedAt,
            method: input.method,
            path: input.path,
            status: "committed",
          })
          .run();
        return { status: "recorded" };
      });
    } catch (err) {
      if (isUniqueViolation(err)) {
        const row = await this.getSpentRequest(input.requestId);
        if (row) return { status: "replay", previousStatus: row.status };
      }
      throw err;
    }
  }

  // ── Deposits ────────────────────────────────────────────────────────────

  async insertDeposit(input: InsertDepositInput): Promise<DepositRecord> {
    try {
      const row = this.use()
        .insert(deposits)
        .values({
          identityId: input.identityId,
          amount: input.amountSats.toString(),
          currency: input.currency,
          txid: input.txid,
          vout: input.vout,
          blockHeight: input.blockHeight,
          blockHash: input.blockHash,
          confirmations: input.confirmations,
          detectedAt: input.detectedAt,
          origin: input.origin,
        })
        .returning()
        .get();
      return this.mapDeposit(row);
    } catch (err) {
      if (isUniqueViolation(err)) {
        throw new StorageError(
          "duplicate-deposit",
          `deposit ${input.txid}:${input.vout} already exists — use remineDeposit for re-mines`,
        );
      }
      throw err;
    }
  }

  async getDeposit(txid: string, vout: number): Promise<DepositRecord | undefined> {
    const row = this.use()
      .select()
      .from(deposits)
      .where(and(eq(deposits.txid, txid), eq(deposits.vout, vout)))
      .get();
    return row ? this.mapDeposit(row) : undefined;
  }

  async remineDeposit(
    txid: string,
    vout: number,
    update: { blockHeight: number; blockHash: string; confirmations: number },
  ): Promise<DepositRecord | undefined> {
    const row = this.use()
      .update(deposits)
      .set({
        blockHeight: update.blockHeight,
        blockHash: update.blockHash,
        confirmations: update.confirmations,
        reorgedAt: null,
        creditedAt: null,
      })
      .where(and(eq(deposits.txid, txid), eq(deposits.vout, vout)))
      .returning()
      .get();
    return row ? this.mapDeposit(row) : undefined;
  }

  async updateDepositConfirmations(id: number, confirmations: number): Promise<void> {
    this.use().update(deposits).set({ confirmations }).where(eq(deposits.id, id)).run();
  }

  async listUncreditedDeposits(): Promise<DepositRecord[]> {
    return this.use()
      .select()
      .from(deposits)
      .where(and(isNull(deposits.creditedAt), isNull(deposits.reorgedAt)))
      .all()
      .map((row) => this.mapDeposit(row));
  }

  async listDepositsAtOrAbove(blockHeight: number): Promise<DepositRecord[]> {
    return this.use()
      .select()
      .from(deposits)
      .where(and(gte(deposits.blockHeight, blockHeight), isNull(deposits.reorgedAt)))
      .all()
      .map((row) => this.mapDeposit(row));
  }

  async creditDeposit(id: number, creditedAt: number): Promise<CreditDepositResult> {
    return this.writeTx((tx): CreditDepositResult => {
      const row = tx.select().from(deposits).where(eq(deposits.id, id)).get();
      if (!row) return { ok: false, reason: "not-found" };
      if (row.reorgedAt !== null) return { ok: false, reason: "reorged" };
      if (row.creditedAt !== null) return { ok: false, reason: "already-credited" };

      tx.update(deposits).set({ creditedAt }).where(eq(deposits.id, id)).run();

      const amount = BigInt(row.amount);
      const identityRow = tx.select().from(identities).where(eq(identities.identityId, row.identityId)).get();
      let balanceAfter: bigint;
      const identityCreated = !identityRow;
      if (!identityRow) {
        balanceAfter = amount;
        tx.insert(identities)
          .values({
            identityId: row.identityId,
            balance: balanceAfter.toString(),
            createdAt: creditedAt,
            firstDepositAt: creditedAt,
          })
          .run();
      } else {
        balanceAfter = BigInt(identityRow.balance) + amount;
        tx.update(identities)
          .set({
            balance: balanceAfter.toString(),
            firstDepositAt: identityRow.firstDepositAt ?? creditedAt,
          })
          .where(eq(identities.identityId, row.identityId))
          .run();
      }
      this.appendLedger(tx, row.identityId, "deposit", "deposit_credited", amount, balanceAfter, creditedAt, {
        depositId: id,
      });
      return { ok: true, balanceAfterSats: balanceAfter, identityCreated };
    });
  }

  async markDepositReorged(id: number, reorgedAt: number): Promise<MarkReorgedResult> {
    return this.writeTx((tx): MarkReorgedResult => {
      const row = tx.select().from(deposits).where(eq(deposits.id, id)).get();
      if (!row) return { ok: false, reason: "not-found" };
      if (row.reorgedAt !== null) return { ok: false, reason: "already-reorged" };

      tx.update(deposits).set({ reorgedAt }).where(eq(deposits.id, id)).run();
      if (row.creditedAt === null) return { ok: true, wasCredited: false };

      const identityRow = tx.select().from(identities).where(eq(identities.identityId, row.identityId)).get();
      if (!identityRow) return { ok: true, wasCredited: false };
      const balanceAfter = BigInt(identityRow.balance) - BigInt(row.amount);
      tx.update(identities)
        .set({ balance: balanceAfter.toString() })
        .where(eq(identities.identityId, row.identityId))
        .run();
      this.appendLedger(tx, row.identityId, "reorg_adjust", "reorg", -BigInt(row.amount), balanceAfter, reorgedAt, {
        depositId: id,
      });
      return { ok: true, wasCredited: true, balanceAfterSats: balanceAfter };
    });
  }

  // ── Ledger ──────────────────────────────────────────────────────────────

  async listLedgerEntries(identityId: string, options?: { afterId?: number; limit?: number }): Promise<LedgerEntry[]> {
    const query = this.use()
      .select()
      .from(ledgerEntries)
      .where(and(eq(ledgerEntries.identityId, identityId), gt(ledgerEntries.id, options?.afterId ?? 0)))
      .orderBy(asc(ledgerEntries.id));
    const rows = options?.limit !== undefined ? query.limit(options.limit).all() : query.all();
    return rows.map((row) => this.mapLedgerEntry(row));
  }

  async getLedgerSummary(identityId: string): Promise<LedgerSummary> {
    // JS-side bigint summing — SQL SUM over TEXT sats would silently lose exactness
    const rows = this.use()
      .select({ amount: ledgerEntries.amount, balanceAfter: ledgerEntries.balanceAfter })
      .from(ledgerEntries)
      .where(eq(ledgerEntries.identityId, identityId))
      .orderBy(asc(ledgerEntries.id))
      .all();
    let sumSats = 0n;
    for (const row of rows) sumSats += BigInt(row.amount);
    const summary: LedgerSummary = { entryCount: rows.length, sumSats };
    const last = rows[rows.length - 1];
    if (last !== undefined) summary.latestBalanceAfterSats = BigInt(last.balanceAfter);
    return summary;
  }

  async sumCreditedDeposits(options?: { excludeSimulated?: boolean }): Promise<bigint> {
    const conditions = [isNull(deposits.reorgedAt)];
    if (options?.excludeSimulated === true) conditions.push(ne(deposits.origin, "simulated"));
    const rows = this.use()
      .select({ amount: deposits.amount, creditedAt: deposits.creditedAt })
      .from(deposits)
      .where(and(...conditions))
      .all();
    let sum = 0n;
    for (const row of rows) {
      if (row.creditedAt !== null) sum += BigInt(row.amount);
    }
    return sum;
  }

  // ── Blocklist ───────────────────────────────────────────────────────────

  async isBlocked(identityId: string): Promise<boolean> {
    return (
      this.use()
        .select({ identityId: blockedIdentities.identityId })
        .from(blockedIdentities)
        .where(eq(blockedIdentities.identityId, identityId))
        .get() !== undefined
    );
  }

  async blockIdentity(record: BlockedIdentityRecord): Promise<void> {
    this.use()
      .insert(blockedIdentities)
      .values({
        identityId: record.identityId,
        reason: record.reason ?? null,
        blockedAt: record.blockedAt,
        blockedBy: record.blockedBy ?? null,
      })
      .onConflictDoUpdate({
        target: blockedIdentities.identityId,
        set: { reason: record.reason ?? null, blockedAt: record.blockedAt, blockedBy: record.blockedBy ?? null },
      })
      .run();
  }

  async unblockIdentity(identityId: string): Promise<boolean> {
    return this.use().delete(blockedIdentities).where(eq(blockedIdentities.identityId, identityId)).run().changes > 0;
  }

  async listBlockedIdentities(): Promise<BlockedIdentityRecord[]> {
    return this.use()
      .select()
      .from(blockedIdentities)
      .all()
      .map((row) => {
        const record: BlockedIdentityRecord = { identityId: row.identityId, blockedAt: row.blockedAt };
        if (row.reason !== null) record.reason = row.reason;
        if (row.blockedBy !== null) record.blockedBy = row.blockedBy;
        return record;
      });
  }

  // ── Watcher cursor ──────────────────────────────────────────────────────

  async getWatcherCursor(key: string): Promise<WatcherCursor | undefined> {
    const row = this.use().select().from(watcherCursor).where(eq(watcherCursor.key, key)).get();
    return row ? { lastBlock: row.lastBlock, lastBlockHash: row.lastBlockHash, updatedAt: row.updatedAt } : undefined;
  }

  async setWatcherCursor(key: string, cursor: WatcherCursor): Promise<void> {
    this.use()
      .insert(watcherCursor)
      .values({ key, lastBlock: cursor.lastBlock, lastBlockHash: cursor.lastBlockHash, updatedAt: cursor.updatedAt })
      .onConflictDoUpdate({
        target: watcherCursor.key,
        set: { lastBlock: cursor.lastBlock, lastBlockHash: cursor.lastBlockHash, updatedAt: cursor.updatedAt },
      })
      .run();
  }

  // ── Reconciliation log ──────────────────────────────────────────────────

  async recordReconciliationRun(run: Omit<ReconciliationRun, "id">): Promise<ReconciliationRun> {
    const row = this.use()
      .insert(reconciliationLog)
      .values({
        runAt: run.runAt,
        identitiesChecked: run.identitiesChecked,
        mismatches: run.mismatches,
        detailJson: run.detailJson ?? null,
        durationMs: run.durationMs,
      })
      .returning()
      .get();
    const record: ReconciliationRun = {
      id: row.id,
      runAt: row.runAt,
      identitiesChecked: row.identitiesChecked,
      mismatches: row.mismatches,
      durationMs: row.durationMs,
    };
    if (row.detailJson !== null) record.detailJson = row.detailJson;
    return record;
  }

  async listReconciliationRuns(limit = 50): Promise<ReconciliationRun[]> {
    return this.use()
      .select()
      .from(reconciliationLog)
      .orderBy(desc(reconciliationLog.id))
      .limit(limit)
      .all()
      .map((row) => {
        const record: ReconciliationRun = {
          id: row.id,
          runAt: row.runAt,
          identitiesChecked: row.identitiesChecked,
          mismatches: row.mismatches,
          durationMs: row.durationMs,
        };
        if (row.detailJson !== null) record.detailJson = row.detailJson;
        return record;
      });
  }
}
