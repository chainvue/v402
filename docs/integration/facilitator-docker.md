# Running the facilitator standalone (Docker)

The facilitator is the payment-infrastructure service: signature verify,
balance state, deposit watching, blocklist. One container, SQLite on a volume.

## Quickstart (compose, facilitator + demo API)

```bash
# real watcher — needs a reachable VRSCTEST node
FACILITATOR_AUTH_TOKEN=$(openssl rand -hex 24) \
VERUS_RPC_URL=http://127.0.0.1:18843 VERUS_RPC_USER=… VERUS_RPC_PASS=… \
V402_PAY_TO=myAPI@ \
  docker compose up --build

# contributor quickstart WITHOUT a Verus node (simulated deposits;
# payments still need a node for signature verification)
NODE_ENV=development V402_WATCHER_MODE=simulated \
FACILITATOR_AUTH_TOKEN=dev-token V402_ADMIN_TOKEN=dev-admin \
  docker compose up --build
```

`NODE_ENV=production` + simulated watcher **refuses to boot** unless
`V402_ALLOW_SIMULATED_IN_PROD=true` — simulated deposits create spendable
balance from nothing.

## Standalone container

```bash
docker build -f docker/facilitator.Dockerfile -t chainvue/v402-facilitator .
docker run -p 3000:3000 \
  -e HOST=0.0.0.0 \
  -e FACILITATOR_AUTH_TOKEN=… \
  -e V402_ADMIN_TOKEN=… \
  -e VERUS_RPC_URL=… -e VERUS_RPC_USER=… -e VERUS_RPC_PASS=… \
  -e V402_PAY_TO=myAPI@ -e V402_CANONICAL_DOMAIN=api.example.com \
  -v v402-data:/data \
  chainvue/v402-facilitator
```

## Environment reference

| Variable | Meaning | Default |
|---|---|---|
| `FACILITATOR_AUTH_TOKEN` | Basic-auth token for middleware clients (`/v1/*` payment API). Empty = HTTP API disabled (fail closed) | — (required for http mode) |
| `V402_ADMIN_TOKEN` | Bearer token for `/admin/*`. Empty = admin API disabled | — |
| `VERUS_RPC_URL/_USER/_PASS` | Verus daemon (signature verify + watcher) | required; point at your own `verusd` (localhost in dev) |
| `V402_CHAIN` | network id (M3, canonical field) | `vrsctest` |
| `V402_PAY_TO` | receiving identity = deposit address (MUST be a registered on-chain identity) | `v402-facilitator@` |
| `V402_CANONICAL_DOMAIN` | domain payments are signed against — must equal what the API advertises | `localhost:3001` |
| `V402_WATCHER_MODE` | `real` \| `simulated` | `real` |
| `DB_PATH` | SQLite file (WAL) | `/data/v402.sqlite` in the image |
| `PORT` / `HOST` | bind address (containers need `HOST=0.0.0.0`) | 3000 / 127.0.0.1 |
| `LOG_LEVEL` | pino level | `info` |

Schema migrations run at boot (no entrypoint script needed). Health:
`GET /v1/health` → 200 ok / 503 degraded (wired as the container healthcheck).
Metrics: `GET /metrics` (Prometheus; the metric names are part of the public
observability contract — see the error catalog and conventions in
[`spec/0.1/facilitator-api.md`](../../spec/0.1/facilitator-api.md)).

## Backups

The SQLite volume is the money state. `sqlite3 /data/v402.sqlite ".backup …"`
on a schedule (WAL-safe), or snapshot the volume with the container stopped.
The append-only `ledger_entries` table is the source of truth for
reconciliation — never prune it manually.

## Secrets

Tokens and RPC credentials only ever enter via env (secret manager /
compose env). Nothing secret is baked into images; `.env` is dockerignored.
