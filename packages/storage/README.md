# @chainvue/v402-storage

Storage interface (`IStorage`) for the [v402](https://github.com/chainvue/v402)
facilitator: identities, deposits, spent requests (replay protection +
two-phase debit), append-only ledger, blocklist, watcher cursor, and
reconciliation queries. Ships `InMemoryStorage`, the reference implementation
used by tests and simulated-mode deployments, plus a reusable contract test
suite that any implementation must pass.

The production SQLite implementation lives in
[`@chainvue/v402-storage-sqlite`](https://www.npmjs.com/package/@chainvue/v402-storage-sqlite).

```sh
npm install @chainvue/v402-storage
```

Semantics are documented on the interface itself; the load-bearing ones:
reserve/commit/rollback are strictly conditional and idempotent (safe under
overlapping cron runs), `insufficient` / `unknown-identity` outcomes burn the
`requestId`, and all amounts are exact `bigint` sats.

## License

Apache-2.0
