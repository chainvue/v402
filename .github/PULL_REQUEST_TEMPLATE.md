<!--
Title MUST be a Conventional Commit — it drives multi-semantic-release per package.
  feat(scope): …  (minor)   fix(scope): …  (patch)   perf(scope): …  (patch)
  Breaking change: still 0.x → MINOR, but mark it `!` / `BREAKING CHANGE:` so it's recorded.
  docs|test|refactor|chore|ci|build: …  (no release)
SCOPE the commit to the package it touches (e.g. `fix(verifier): …`) so the right
package releases. Do NOT bump `version` or edit `CHANGELOG.md` by hand.
-->

## What & why

<!-- One or two sentences: what this changes, which package(s), and the motivation. -->

## Money & correctness (load-bearing — custody core holds real balances)

- [ ] Amounts are `bigint` satoshis everywhere; human decimals only at boundaries (`packages/protocol/src/amount.ts`). No float money.
- [ ] Every composite storage op is ATOMIC (SQLite `BEGIN IMMEDIATE`). The **ledger is the source of truth** — every balance movement writes exactly one ledger row.
- [ ] The solvency invariant (`balance == latest ledger.balance_after`) still holds — asserted at entry and commit of each balance-mutating op.
- [ ] Two-phase debit + `requestId` replay protection intact. No naive `CHECK(balance >= 0)` (negative balance is intentional in late-commit / reorg).
- [ ] Fail-closed guards preserved: constant-time token compares; empty admin token → 401; balance-minting admin endpoints carry an audited `operator`.

## Storage / schema changes

<!-- Delete if N/A. -->
- [ ] Behavior is defined by `packages/storage/test/storage-contract.ts` and passes on **BOTH** backends (memory + sqlite).
- [ ] Schema changes went through drizzle-kit (`generate:migrations`); migrations are additive and run on startup.

## Checklist

- [ ] Gate green in order: `pnpm build` (**first** — packages resolve via `dist/`) → `pnpm typecheck` → `pnpm lint` → `pnpm test:coverage` (thresholds enforced).
- [ ] New/changed behavior has a test; money/atomicity/replay paths have explicit coverage.
- [ ] `pnpm smoke` considered (needs the compose stack + `V402_ADMIN_TOKEN`); real-RPC `verifymessage` path noted if untested here.
- [ ] Conventional-Commit PR title **scoped to the right package**; no manual `version`/`CHANGELOG.md` edits.

## Notes for reviewers

<!-- Risks, follow-ups, deliberate scope limits, cross-package impact. -->
