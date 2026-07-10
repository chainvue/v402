# @chainvue/v402-storage-sqlite

SQLite implementation of the [v402](https://github.com/chainvue/v402) storage
interface ([`@chainvue/v402-storage`](https://www.npmjs.com/package/@chainvue/v402-storage)):
Drizzle schema, embedded migrations (applied at construction — no separate
migration step), WAL mode, `BEGIN IMMEDIATE` write transactions, append-only
ledger. Built on `better-sqlite3`.

```sh
npm install @chainvue/v402-storage-sqlite
```

```ts
import { SqliteStorage } from "@chainvue/v402-storage-sqlite";

const storage = new SqliteStorage({ path: "/data/v402.sqlite" });
```

Note: `better-sqlite3` is a native module — container builds need matching
prebuilds or a build toolchain (see the repo's
[docker/](https://github.com/chainvue/v402/tree/main/docker) for a working
multi-stage build).

## License

Apache-2.0
