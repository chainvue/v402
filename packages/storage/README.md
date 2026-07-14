# @chainvue/v402-storage

Storage interface (`IStorage`) for the [v402](https://github.com/chainvue/v402) facilitator: identities, deposits, spent requests (replay protection + two-phase debit), append-only ledger, blocklist, watcher cursor, reconciliation. Ships `InMemoryStorage` (the reference implementation used in tests and simulated mode) plus a reusable contract-test suite every backend must pass.

```sh
npm install @chainvue/v402-storage
```

```ts
import { InMemoryStorage, type IStorage } from "@chainvue/v402-storage";

const storage: IStorage = new InMemoryStorage();
```

## What it does

- Defines `IStorage` — the contract the facilitator and verifier depend on
- `InMemoryStorage` — reference impl; production SQLite lives in [`@chainvue/v402-storage-sqlite`](https://www.npmjs.com/package/@chainvue/v402-storage-sqlite)
- Contract test suite any implementation must pass

## Good to know

- reserve/commit/rollback are strictly conditional and idempotent — safe under overlapping cron runs.
- `insufficient` / `unknown-identity` outcomes burn the `requestId`; all amounts are exact `bigint` sats.

## License

Apache-2.0
