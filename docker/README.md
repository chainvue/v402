# docker/

Deployment artifacts (plan § Deployment):

- `facilitator.Dockerfile` — multi-stage: workspace build (with native-module
  toolchain for better-sqlite3), then a minimal non-root runtime from
  `pnpm deploy --prod`. SQLite on the `/data` volume, healthcheck on
  `/v1/health`.
- `demo-server.Dockerfile` — same recipe; runs in http mode inside compose
  (no volume needed).
- `../docker-compose.yml` — facilitator + demo-server + SQLite volume.
  Quickstarts are documented at the top of that file (incl. the
  simulated-watcher contributor path that needs no Verus node).
- `../docker-compose.dev.yml` — parked Postgres/Redis overlay for later
  phases (profile `future`; nothing consumes them yet).

No entrypoint script: schema migrations run at application boot
(SqliteStorage.initialize), so the container entrypoint is plain `node`.
