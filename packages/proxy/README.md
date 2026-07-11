# @chainvue/v402-proxy

Reverse proxy for [v402](https://github.com/chainvue/v402): a standalone
payment guard in front of **any** existing origin — a static site, WordPress,
an API in any language. No origin changes: the proxy matches route rules,
challenges with 402, verifies and reserves via a v402 facilitator (HTTP
mode), and streams paid requests through. The self-hosted pay-per-crawl
answer for protecting whole sites against AI crawlers — every priced request
is paid up front from a prepaid VerusID balance.

```sh
npm install @chainvue/v402-proxy   # or run the container, see below
```

## How it works

```
client ──► v402-proxy ──► your origin (untouched)
               │
               └──► facilitator  (verify / reserve / commit / rollback)
```

- Unmatched or `free` routes pass through untouched, bodies streamed.
- Priced routes run the standard two-phase flow: reserve before forwarding,
  **commit on definitive answers (2xx AND 4xx)**, rollback on origin
  failures (≥ 500 / unreachable) — the client is never charged for an
  undelivered response.
- `GET /.well-known/v402` serves the discovery document with a rate card
  derived from the rules; `GET /.well-known/v402/health` is the liveness
  probe.

## Route rules (`rules.json`)

First match wins — put free holes before broad prefixes:

```json
{
  "version": 1,
  "rules": [
    { "match": "/health", "free": true },
    { "match": "/api", "method": "POST", "price": "0.002", "bodyHash": "required" },
    { "match": "/*", "price": "0.0001" }
  ]
}
```

- `match`: exact pathname or trailing-`*` prefix (matched without the query).
- `price`: exact decimal string advertised in the 402 — compared byte-wise
  (M6), never reformat it.
- `bodyHash`: default `ignored` (bodies stream). `required`/`optional`
  buffer request bodies (cap: `V402_PROXY_MAX_BODY_BYTES`, default 1 MiB) to
  bind them into the signature.

## Configuration (env)

| Variable | Meaning |
|---|---|
| `V402_PROXY_UPSTREAM` | origin base URL, e.g. `http://origin:8080` |
| `V402_PROXY_RULES_PATH` | rules file path (container default `/rules/rules.json`) |
| `FACILITATOR_URL` | facilitator the proxy CALLS (in-cluster) |
| `FACILITATOR_PUBLIC_URL` | facilitator advertised to clients (defaults to `FACILITATOR_URL`) |
| `FACILITATOR_AUTH_TOKEN` | operator-provisioned middleware token (Basic) |
| `V402_CANONICAL_DOMAIN` | domain signatures bind to — MUST match what clients see |
| `V402_NETWORK` / `V402_ASSET` / `V402_PAY_TO` | advertisement fields |
| `V402_PROXY_HOST` / `V402_PROXY_PORT` | listen address (default `0.0.0.0:8402`) |

**The facilitator must be configured with the SAME `canonicalDomain` and
`payTo`** — it rebuilds the signed canonical payload from its own config.

**TLS terminates in front of the proxy** (load balancer, caddy, traefik).
Signatures bind `canonicalDomain`, so the advertised domain must be exactly
what clients see.

## Run it

```sh
FACILITATOR_AUTH_TOKEN=… V402_CANONICAL_DOMAIN=api.example.com \
  docker compose -f docker-compose.proxy.yml up --build
```

or as a library: `createProxyServer(buildProxyConfig(process.env)).listen(8402)`.

## License

Apache-2.0
