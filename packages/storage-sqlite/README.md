# @chainvue/v402-storage-sqlite

SQLite (WAL) implementation of the [v402](https://github.com/chainvue/v402) storage interface ([`@chainvue/v402-storage`](https://www.npmjs.com/package/@chainvue/v402-storage)): Drizzle schema, embedded migrations, `BEGIN IMMEDIATE` write transactions, append-only ledger. Built on `better-sqlite3`.

```sh
npm install @chainvue/v402-storage-sqlite
```

```ts
import { SqliteStorage } from "@chainvue/v402-storage-sqlite";

// migrations apply at construction — no separate migration step
const storage = new SqliteStorage({ path: "/data/v402.sqlite" });
```

## Good to know

- `better-sqlite3` is a native module — container builds need matching prebuilds or a build toolchain (see [docker/](https://github.com/chainvue/v402/tree/main/docker) for a working multi-stage build).

## License

Apache-2.0
