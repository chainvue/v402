# CLAUDE.md — v402 (custody / payments monorepo)

pnpm workspace for the v402 pay-per-request protocol: `facilitator` (NestJS
API), `verifier`, `storage` + `storage-sqlite`, `deposit-watcher`, `protocol`,
`signer-verus`, `verus-rpc`, clients, MCP, proxy. The custody core holds real
prepaid balances — treat it as money-critical.

## Money & correctness — load-bearing
- Amounts are `bigint` satoshis everywhere; human decimals only at boundaries
  (`packages/protocol/src/amount.ts`). No float money.
- Every composite storage op is ATOMIC (SQLite `BEGIN IMMEDIATE`; the in-memory
  backend is synchronous). The **ledger is the source of truth**; every balance
  movement writes exactly one ledger row. A solvency invariant
  (`balance == latest ledger.balance_after`) is asserted at the entry and
  commit of each balance-mutating op.
- Two-phase debit with requestId replay protection. Negative balance is
  intentional in late-commit / reorg — never add a naive `CHECK(balance>=0)`.
- Fail-closed guards (constant-time token compares; empty admin token → 401).
  Balance-minting admin endpoints require an audited `operator`.

## Storage rule
Behavior is defined by `packages/storage/test/storage-contract.ts` and MUST
pass on BOTH backends (memory + sqlite). Schema changes go through drizzle-kit
(`pnpm --filter @chainvue/v402-storage-sqlite generate:migrations`); migrations
are additive and run on startup.

## Conventions
- License **Apache-2.0** for code; **CC-BY-4.0** for the spec (`LICENSE-SPEC`)
  and `@chainvue/v402-test-vectors` (data, not code). Node ≥ 22, pnpm ≥ 10.

## Gate (run before claiming done, in order)
`pnpm build` **first** (workspace packages resolve each other via `dist/`) →
`pnpm typecheck` → `pnpm lint` → `pnpm test:coverage` (thresholds enforced).
`pnpm smoke` needs the docker-compose stack + `V402_ADMIN_TOKEN`; the real-RPC
`verifymessage` path needs a `verusd` (gated suites skip without it).

## Releases — automated, do not hand-roll
Conventional Commits drive **semantic-release** (multi-package; each package
versions independently). **Never hand-bump `version` fields or edit
`CHANGELOG.md`** — the pipeline derives both from commits. Scope commits so the
right package releases (e.g. `fix(verifier): …`). A breaking change to a
published API (e.g. the admin `operator` requirement) must be marked `!` /
`BREAKING CHANGE:`. Do not `git push`, tag, or publish without an explicit ask.

## Decision log
`docs/RISKS.md` = maintainer-facing "why"; `CHANGELOG.md` = adopter-facing.
