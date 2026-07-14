# @chainvue/v402-proxy

Reverse proxy for [v402](https://github.com/chainvue/v402): a standalone payment guard in front of **any** origin — a static site, WordPress, an API in any language. No origin changes. It matches route rules, challenges unpaid requests with 402, verifies/reserves via a v402 facilitator, and streams paid traffic through. The self-hosted pay-per-crawl answer for whole sites.

```
client ──► v402-proxy ──► your origin (untouched)
               └──► facilitator (verify / reserve / commit / rollback)
```

## Run it

```sh
FACILITATOR_AUTH_TOKEN=… V402_CANONICAL_DOMAIN=api.example.com \
  docker compose -f docker-compose.proxy.yml up --build
```

Or as a library (`npm install @chainvue/v402-proxy`, bin `v402-proxy`):

```ts
createProxyServer(buildProxyConfig(process.env)).listen(8402);
```

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

- `match` — exact pathname or trailing-`*` prefix (query ignored).
- `price` — exact decimal string; advertised and compared byte-wise, never reformat it.
- `bodyHash` — default `ignored` (bodies stream); `required`/`optional` buffer the request body (cap `V402_PROXY_MAX_BODY_BYTES`, default 1 MiB) to bind it into the signature.

## Key config (env)

| Variable | Meaning |
|---|---|
| `V402_PROXY_UPSTREAM` | origin base URL, e.g. `http://origin:8080` |
| `V402_PROXY_RULES_PATH` | rules file path (container default `/rules/rules.json`) |
| `FACILITATOR_URL` | facilitator the proxy calls (in-cluster) |
| `FACILITATOR_PUBLIC_URL` | facilitator advertised to clients (defaults to `FACILITATOR_URL`) |
| `FACILITATOR_AUTH_TOKEN` | operator-provisioned middleware token (Basic) |
| `V402_CANONICAL_DOMAIN` | domain signatures bind to — MUST match what clients see |
| `V402_NETWORK` / `V402_ASSET` / `V402_PAY_TO` | advertisement fields |
| `V402_PROXY_HOST` / `V402_PROXY_PORT` | listen address (default `0.0.0.0:8402`) |

## Good to know

- Priced routes commit on definitive answers (2xx **and** 4xx), rollback on origin failure (≥ 500 / unreachable) — clients are never charged for an undelivered response.
- The facilitator must be configured with the SAME `canonicalDomain` and `payTo`; it rebuilds the signed payload from its own config. Terminate TLS in front of the proxy.
- `GET /.well-known/v402` serves the discovery document; `/.well-known/v402/health` is the liveness probe.

## License

Apache-2.0
