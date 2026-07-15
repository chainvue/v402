# Changelog

Format follows [Keep a Changelog](https://keepachangelog.com): newest first.
Because packages version independently, each release section is headed by date
and theme (`## <date> — <theme>`) with a `### <package> <old> → <new>`
subsection per changed package; the release workflow publishes any package
whose version is not yet on the registry. Record changes under **[Unreleased]**
as you make them. Data/spec packages (`test-vectors`, the protocol spec) are
versioned separately. This file is adopter-facing ("what changed, what breaks");
design rationale is maintained privately.

## [Unreleased]

<!-- Add entries here in the same commit as the change; move them under a dated
     release heading with per-package version subsections at release time. -->

## 2026-07-14 — custody hardening

Right-sized hardening of the custody core. No changes to the money model — sats
stay `bigint` end-to-end.

### `@chainvue/v402-storage` 0.2.0 → 0.3.0 (minor)
- **New** `IStorage.insertAndCreditDeposit(input, creditedAt)`: books a deposit
  insert + credit in one atomic transaction (the admin mint path), so a crash
  can never leave an uncredited spendable-looking row. Additive to the
  interface — only the two in-tree implementations change.
- `InsertDepositInput`/`DepositRecord` gain optional `createdBy` (operator
  attribution) and `note`.
- A solvency invariant (`balance == latest ledger.balance_after`) is asserted
  at the entry and commit of every balance-mutating op.

### `@chainvue/v402-storage-sqlite` 0.2.0 → 0.3.0 (minor)
- Implements `insertAndCreditDeposit` and the solvency invariant.
- **Migration `0001_grey_lightspeed`** adds `deposits.created_by` and
  `deposits.note` (runs automatically on startup; additive, no backfill).

### `@chainvue/v402-facilitator` 0.2.0 → 0.3.0 (minor — contains a breaking API change)
- **BREAKING (admin API):** `POST /admin/credit` and
  `POST /admin/simulate-deposit` now **require** an `operator` string
  (1–100 chars). Requests without it get 400. The value is persisted as
  attribution and emitted as a structured `admin.credit` /
  `admin.simulate-deposit` audit log line.
- Admin mint now uses the atomic `insertAndCreditDeposit`.
- Metric-only `Number(amountSats)` coercion clamps at `MAX_SAFE_INTEGER`; the
  reconciliation float crosscheck is documented as advisory-only.

### `@chainvue/v402-verifier` 0.1.4 → 0.1.5 (patch)
- `verifyAndReserve` short-circuits a known `requestId` to `replay` from local
  storage **before** the `verifymessage` RPC — a captured, already-spent
  request can no longer force a full RPC per retry. No API change.

### `@chainvue/v402-deposit-watcher` 0.1.1 → 0.1.2 (patch)
- Simulated deposits route through the atomic `insertAndCreditDeposit` and
  accept optional `createdBy`/`note` attribution. No API change.

### Tests / CI (unpublished)
- Adversarial storage tests on both backends (concurrent double-spend,
  cross-process serialization, mid-transaction rollback, corruption detection),
  replay-amplification and admin-disabled coverage.
- CI: Node 22 + 26 matrix, a coverage gate, `pnpm audit`, and gitleaks.
