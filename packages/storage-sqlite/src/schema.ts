import { index, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

/**
 * Drizzle schema mirroring PLAN.md § Data Model. Amounts are TEXT
 * satoshi-strings (Q3) — bigint conversion happens in the repository layer.
 *
 * Deliberate deviation from the plan's DDL sketch: no FK from
 * `deposits.identity_id` to `identities` — the watcher inserts deposit rows
 * BEFORE the identity is auto-provisioned at credit time, so the constraint
 * could never be enforced (the sketch only "worked" because SQLite ships with
 * foreign-key enforcement off by default).
 */

export const identities = sqliteTable("identities", {
  identityId: text("identity_id").primaryKey(),
  balance: text("balance").notNull().default("0"),
  createdAt: integer("created_at").notNull(),
  firstDepositAt: integer("first_deposit_at"),
  lastRequestAt: integer("last_request_at"),
});

export const deposits = sqliteTable(
  "deposits",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    identityId: text("identity_id").notNull(),
    amount: text("amount").notNull(),
    currency: text("currency").notNull(),
    txid: text("txid").notNull(),
    vout: integer("vout").notNull(),
    blockHeight: integer("block_height").notNull(),
    blockHash: text("block_hash").notNull(),
    confirmations: integer("confirmations").notNull(),
    detectedAt: integer("detected_at").notNull(),
    creditedAt: integer("credited_at"),
    reorgedAt: integer("reorged_at"),
    origin: text("origin").notNull().default("real"),
  },
  (t) => [uniqueIndex("ux_deposits_txid_vout").on(t.txid, t.vout)],
);

export const spentRequests = sqliteTable(
  "spent_requests",
  {
    requestId: text("request_id").primaryKey(),
    identityId: text("identity_id").notNull(),
    issuedAt: integer("issued_at").notNull(),
    amount: text("amount").notNull(),
    receivedAt: integer("received_at").notNull(),
    method: text("method").notNull(),
    path: text("path").notNull(),
    status: text("status").notNull(),
    responseBytes: integer("response_bytes"),
  },
  (t) => [
    index("idx_spent_requests_issued_at").on(t.issuedAt),
    index("idx_spent_requests_identity").on(t.identityId),
    index("idx_spent_requests_status_received").on(t.status, t.receivedAt),
  ],
);

export const ledgerEntries = sqliteTable(
  "ledger_entries",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    identityId: text("identity_id").notNull(),
    kind: text("kind").notNull(),
    reason: text("reason").notNull(),
    amount: text("amount").notNull(),
    requestId: text("request_id"),
    depositId: integer("deposit_id"),
    balanceAfter: text("balance_after").notNull(),
    createdAt: integer("created_at").notNull(),
  },
  (t) => [index("idx_ledger_identity").on(t.identityId, t.id)],
);

export const blockedIdentities = sqliteTable("blocked_identities", {
  identityId: text("identity_id").primaryKey(),
  reason: text("reason"),
  blockedAt: integer("blocked_at").notNull(),
  blockedBy: text("blocked_by"),
});

export const watcherCursor = sqliteTable("watcher_cursor", {
  key: text("key").primaryKey(),
  lastBlock: integer("last_block").notNull(),
  lastBlockHash: text("last_block_hash").notNull(),
  updatedAt: integer("updated_at").notNull(),
});

export const reconciliationLog = sqliteTable("reconciliation_log", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  runAt: integer("run_at").notNull(),
  identitiesChecked: integer("identities_checked").notNull(),
  mismatches: integer("mismatches").notNull(),
  detailJson: text("detail_json"),
  durationMs: integer("duration_ms").notNull(),
});
