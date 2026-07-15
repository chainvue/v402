# Facilitator HTTP API — v402/0.1

**Status:** Normative (frozen 2026-07-10; tracks the reference implementation).
Semantics locked by the reference test suites; wording may still be edited.

The facilitator is the payment-infrastructure service between customer and
API operator: signature verification, balance state, deposit watching,
blocklist enforcement. This document is the contract for **any**
implementation (Rust, Go, Python, …) of either side — a middleware calling a
facilitator, or a facilitator serving middlewares.

Deployment modes (identical interface): **in-process** (the middleware links
the verifier library directly) and **http** (this API). Switching is a
configuration change; the method shapes below mirror the library interface
one-to-one.

A machine-readable OpenAPI 3.1 document lives alongside this file
(`facilitator-api.openapi.yaml`), validated against the reference
implementation on every CI run. This markdown remains normative; on any
conflict the markdown wins.

## Conventions

- All bodies are JSON. Satoshi amounts travel as **decimal strings**
  (`"100000"`) — never JSON numbers.
- Success envelope: `{ "ok": true, … }`. Error envelope:
  `{ "ok": false, "error": { "code", "message", "details"? } }` with the
  HTTP status carrying the class of the error (see § Error catalog).
- Header names are case-insensitive; middlewares MUST forward client payment
  headers with lowercase keys in JSON maps.

## Authentication

Payment endpoints (`/v1/verify`, `/v1/reserve`, `/v1/commit`,
`/v1/rollback`, `/v1/identity/:id`) require **HTTP Basic**: username =
middleware identifier (free-form, logged), password = the operator-provisioned
middleware token. Unauthenticated → 401. A facilitator with no token
configured MUST reject all these calls (fail closed).

Admin endpoints (`/admin/*`) require `Authorization: Bearer <admin token>`,
same fail-closed rule.

Public (no auth): `GET /.well-known/v402`, `GET /v1/topup-instructions`,
`GET /v1/health`, `GET /metrics`. `GET /v1/balance` authenticates via
signature (below).

## Payment endpoints

### POST /v1/verify — stateless verification

Runs every check up to and including the signature RPC. **No storage writes:
no replay check, no balance check, nothing is reserved or burned.** Answers
"is this signature/payload valid right now", not "would this payment
succeed".

Request (identical body for `/v1/reserve`):

```json
{
  "method": "GET",
  "path": "/api/tx/abc",
  "headers": { "x-v402-scheme": "verus-prepaid-sig/0.1", "x-v402-payer": "…", "…": "…" },
  "rawBodyBase64": "…",
  "policy": { "priceHuman": "0.001", "bodyHashPolicy": "optional" }
}
```

- `path` — the request-target **verbatim** as received (M1), incl. query string.
- `headers` — the client's headers (at minimum all `x-v402-*`); the scheme is
  dispatched from `x-v402-scheme`.
- `rawBodyBase64` — the raw request body; required to enforce
  `bodyHashPolicy: "required" | "optional"`. `"ignored"` skips verification.
- `policy.priceHuman` — the route's current price string, compared byte-wise
  against `X-V402-Amount` (M6) and embedded verbatim into the rebuilt
  canonical payload.

Response 201:

```json
{ "ok": true, "requestId": "01H8…", "payer": "v402test.demoagent@", "amountSats": "100000" }
```

`payer` is the **normalized identity key** (lowercased chain-relative
friendly name) — the balance account, not necessarily the casing the client
signed.

### POST /v1/reserve — verify + phase-1 debit

Same request body. Runs verify, then atomically: burn `requestId` (replay
protection), check + decrement the balance, append the ledger row.

Response 201:

```json
{ "ok": true, "requestId": "01H8…", "payer": "…", "amountSats": "100000", "balanceAfterSats": "0" }
```

`reserve` is **idempotent per requestId**: a repeat is answered 409
`replay` with `details.previousStatus` — for a retrying client that IS the
authoritative answer (M5: `committed` = paid, response lost; `error` =
refunded).

### POST /v1/commit — phase 2, success

```json
{ "requestId": "01H8…", "responseBytes": 1234, "scheme": "verus-prepaid-sig" }
```

`scheme` is optional (defaults to the facilitator's default scheme);
`responseBytes` defaults to 0. Response 201:

```json
{ "ok": true, "alreadyCommitted": false, "late": false }
```

- Idempotent: repeating yields `alreadyCommitted: true`.
- **Late commit (B3):** if the reaper already refunded the reservation, the
  facilitator re-debits deterministically and answers `late: true` plus
  `balanceAfterSats` (MAY be negative — operator flag; money is booked late,
  never lost).

### POST /v1/rollback — phase 2, failure

```json
{ "requestId": "01H8…", "scheme": "verus-prepaid-sig" }
```

Refunds the reserved amount, marks the request errored; the requestId stays
burned for the replay window. Response 201
`{ "ok": true, "alreadyRolledBack": false }`; idempotent.

**Normative middleware semantics:** commit on handler success (2xx) **and on
definitive client errors (4xx)** — a definitive answer is a rendered
service; rollback only for handler failures (≥500).

### GET /v1/identity/:id

On-chain identity lookup (primaries, minimum signatures, revocation status —
the offline verifier's cache-refresh source, Etappe 1.5) plus this
facilitator's account view:

```json
{
  "ok": true,
  "identity": { "name": "fum", "identityaddress": "i4Kt…", "primaryaddresses": ["R…"], "minimumsignatures": 1, "…": "…" },
  "status": "active",
  "blockheight": 1140465,
  "fullyqualifiedname": "fum.VRSCTEST@",
  "account": { "identityId": "fum@", "balanceSats": "100000000", "createdAt": 1783650000 }
}
```

`account` is `null` when the identity has no balance account here. Unknown
identity → 404 `unknown-identity`; node unreachable → 503.

## Public endpoints

### GET /.well-known/v402 — discovery

```json
{
  "specUrl": "…",
  "canonicalDomain": "api.example.com",
  "network": "vrsctest",
  "supportedVersions": ["v402/0.1"],
  "defaultVersion": "v402/0.1",
  "deprecatedVersions": [],
  "sunsetDates": {},
  "supportedExtensions": ["scheme.bodyHash"],
  "defaultScheme": "verus-prepaid-sig",
  "schemes": [
    { "scheme": "verus-prepaid-sig", "schemeVersion": "0.1", "network": "vrsctest", "asset": "VRSCTEST", "payTo": "myAPI@" }
  ],
  "topup": { "depositAddress": "myAPI@", "attribution": "sender-verusid", "instructionsEndpoint": "/v1/topup-instructions" }
}
```

`canonicalDomain` + `network` let clients build the signed balance query
without out-of-band configuration. Unauthenticated — HTTPS REQUIRED in
production; clients SHOULD pin `payTo`.

### GET /v1/topup-instructions?identity=…&amount=…

`identity` required (VerusID friendly name), `amount` optional. Response 200:

```json
{
  "instructions": { "text": "Send 5 VRSCTEST from v402.a@ to myAPI@", "paymentUri": "verus://send?…", "qrCode": "data:image/png;base64,…" },
  "network": "vrsctest",
  "asset": "VRSCTEST",
  "expectedConfirmations": 10,
  "estimatedTimeMinutes": 10,
  "pollBalanceEndpoint": "/v1/balance?identity=…"
}
```

### GET /v1/balance — signature-authenticated

Headers: `X-V402-Payer`, `X-V402-Request-Id` (fresh ULID),
`X-V402-Issued-At` (unix seconds, ±300 s window), `X-V402-Signature` over the
domain-separated canonical payload (spec § canonical-payload):

```
v402-balance-query/0.1
canonicalDomain: <discovery.canonicalDomain>
network: <discovery.network>
payer: <as signed>
requestId: <ULID>
issuedAt: <unix seconds>
```

Replay-protected like payments (repeat → 409 with `previousStatus`).
Response 200:

```json
{
  "identity": "v402.demoagent@",
  "balance": "1.9969", "reserved": "0.0001", "available": "1.9968",
  "balanceSats": "199690000", "reservedSats": "10000", "availableSats": "199680000",
  "firstDepositAt": 1783650000, "lastRequestAt": 1783650123
}
```

Human amounts use the minimal decimal form; the `*Sats` strings are exact.
Identities without an account get zeros (VerusIDs are public on-chain; the
signature requirement already restricts reads to the identity owner).

### GET /v1/health

200 `{"status":"ok", "verusRpc": {…}, "watcher": {…}}` when healthy, 503
`status: "degraded"` otherwise. `verusRpc.blocks` doubles as the chain-height
source for local identity signers.

## Admin endpoints (Bearer token)

- `POST /admin/simulate-deposit` `{identity, amount, txid?}` — simulated
  watcher mode only (409 `not-simulated` otherwise); credits instantly,
  records `origin: "simulated"`.
- `POST /admin/credit` `{identity, amount, txid?, note?}` — manual support
  credit in any mode; recorded as simulated origin (excluded from on-chain
  crosschecks).
- `POST /admin/reconcile` — on-demand ledger-invariant check; returns
  `{identitiesChecked, mismatches, detail, onChain, durationMs}`.

## Rate limiting

Unauthenticated requests are throttled per IP (default 100/min) → 429 with
`Retry-After`. Requests with a valid middleware/admin token, plus `/metrics`
and `/v1/health`, are exempt. Per-token limits are an Etappe-2 extension.

## Error catalog

The `error.code` values are stable identifiers (renaming is a breaking
change). HTTP status by class:

| HTTP | Codes | Client action (M5) |
|---|---|---|
| 400 | `invalid-body`, `invalid-headers`, `invalid-request`, `unsupported-scheme-version`, `timestamp-out-of-window`, `extensions-too-large`, `invalid-extensions`, `unknown-scheme-extension`, `reserved-extension`, `body-hash-required`, `body-hash-mismatch`, `invalid-body-hash`, `invalid-identity`, `invalid-amount` | fix the request; fresh ULID |
| 401 | (Basic/Bearer auth failures) | fix credentials |
| 402 | `unsupported-scheme`, `price-mismatch` (+ current `accepts`), `invalid-signature`, `insufficient-balance` (details: `balanceSats`, `requiredSats`, `depositAddress`), `no-balance` | `price-mismatch`: re-sign at the new price, fresh ULID; `insufficient`/`no-balance`: top up, fresh ULID |
| 403 | `blocked` | none — contact the operator |
| 404 | `unknown-request`, `unknown-identity` | — |
| 409 | `replay` (details: `previousStatus`), `invalid-state`, `not-simulated`, `duplicate-deposit` | `replay` is the definitive answer — do NOT retry |
| 429 | (throttle) | wait `Retry-After`, retry with the SAME requestId |
| 503 | `verify-unavailable` (details: `retryAfterSec`) | retry with the SAME requestId — nothing was reserved |

## Versioning

This API is versioned with the protocol (`v402/0.1`) under the path prefix
`/v1`. Additive response fields are MINOR (clients MUST tolerate unknown
fields); removing/renaming fields or codes is MAJOR.
