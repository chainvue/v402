# Canonical Payload & Wire Format — v402/0.1

**Status:** NORMATIVE for protocol version `v402/0.1`.

This document defines the exact byte string a client signs and a server
rebuilds. A deviation of a single byte is a verification failure — this is
the byte-level contract between independent implementations. The envelope
around it is specified in [`protocol.md`](./protocol.md); how the string is
signed is scheme-specific ([`prepaid-sig-scheme.md`](./prepaid-sig-scheme.md)).

## 1. Canonical string layout

```
verus-prepaid-sig/0.1
canonicalDomain: explorer.example.com
method: GET
path: /api/tx/abc
scheme: verus-prepaid-sig
network: vrsctest
asset: VRSCTEST
amount: 0.001
payer: v402test.demoAgent@
payTo: explorerAPI@
requestId: 01H8XG7Q4M2N8P5R7T3V9WXYZA
issuedAt: 1783650000
```

- Line 1 is the **scheme context line**: `<scheme>/<schemeVersion>` — no
  `key:` prefix. It domain-separates payloads between schemes and scheme
  versions.
- Then the **11 core fields**, exactly in the order above, as
  `key: value` lines.
- An OPTIONAL **extension section** follows (§ 5).

## 2. Byte-level rules

- Line separator is LF (`\n`) only. CR anywhere → invalid.
- Exactly one colon-space (`: `) between key and value. No other
  whitespace variance.
- **No trailing newline** after the last line (core or extension).
- The string is UTF-8; values MUST NOT contain whitespace or control
  characters (space, tab, CR, LF, `\x00–\x1f`, `\x7f`) — with the single
  exception that extension VALUES may contain spaces (but not leading
  space, CR, or LF; § 5).
- Implementations MUST validate every field before signing or verifying;
  a payload that violates any grammar below MUST NOT be signed and MUST
  NOT verify (fail closed).

## 3. Field serialization (normative grammars)

| Field | Rule |
|---|---|
| `scheme` | `^[a-z0-9]+(?:-[a-z0-9]+)*$` |
| `schemeVersion` | `^\d+\.\d+$` (MAJOR.MINOR) |
| `canonicalDomain` | non-empty, no whitespace/control chars; the domain the server binds signatures to |
| `method` | `^[A-Z]+$` (uppercase HTTP method) |
| `path` | § 4 |
| `network` | `^[a-z0-9]+$` (e.g. `vrsc`, `vrsctest`) |
| `asset` | non-empty, no whitespace/control chars (e.g. `VRSCTEST`) |
| `amount` | `^(?:0|[1-9]\d*)(?:\.\d{1,8})?$` — non-negative decimal, no leading zeros, `.` separator, 1–8 fraction digits. Trailing fraction zeros are permitted: amounts are signed and compared **byte-verbatim**, never normalized |
| `payer`, `payTo` | identity string: non-empty, no whitespace/control chars, MUST end with `@` (charset/existence rules are chain-side, scheme document) |
| `requestId` | ULID: `^[0-7][0-9A-HJKMNP-TV-Z]{25}$` (Crockford base32, 26 chars, 128 bit) |
| `issuedAt` | Unix seconds as decimal integer, no leading zeros, non-negative |

## 4. `path` — the verbatim rule (M1)

`path` is the request-target **exactly as sent on the wire**, including
the query string when present (`/api/search?q=foo%20bar&limit=10`); no `?`
for an empty query.

- No normalization on either side: no re-encoding, no parameter
  reordering, byte-exact comparison against the raw request-target.
- Clients MUST build the URL once and use the identical string for
  signing and sending.
- `path` MUST start with `/`; the path part (before `?`) MUST NOT contain
  dot-segments (`.` or `..`) or duplicate slashes (`//`) — both sides fail
  closed on these.
- Path-rewriting proxies in front of the server are unsupported.
- For single-endpoint protocols (GraphQL, MCP, JSON-RPC) the path is
  constant — request binding comes from `scheme.bodyHash`
  ([`prepaid-sig-scheme.md`](./prepaid-sig-scheme.md) § 8).

## 5. Extension section

Placement: immediately after `issuedAt`, separated by a single LF.

```
verus-prepaid-sig/0.1
…
issuedAt: 1783650000
scheme.bodyHash: sha256:a1b2c3…
x-mystartup.orderId: ord_12345
```

- Keys MUST match the extension key grammar
  ([`protocol.md`](./protocol.md) § 6):
  `^(?:scheme|iana|x-[a-z0-9]+(?:-[a-z0-9]+)*)\.[A-Za-z][A-Za-z0-9]*$`.
- Values MUST be non-empty, single-line (no CR/LF), and MUST NOT start
  with a space.
- Lines are sorted **strictly ascending bytewise by key** — duplicate keys
  are invalid. Sorting is the serializer's job so all parties produce
  identical bytes regardless of input order.
- No trailing newline after the last extension line.
- Wire transport: the extension section travels base64-encoded in
  `X-V402-Extensions`, byte-identical to what was signed. The server MUST
  validate (grammar, order, size ≤ 4096 bytes decoded, prefix rules) and
  then append the decoded block **verbatim** to its self-rebuilt core
  string before verifying the signature.

## 6. Server-side rebuild rule

The server never verifies a client-supplied canonical string. It rebuilds
the payload from **server truth** and verifies the signature against the
rebuilt bytes:

- From configuration: `canonicalDomain`, `scheme`, `schemeVersion` (the
  negotiated one), `network`, `asset`, `payTo`.
- From the current price: `amount` (after the byte-verbatim comparison
  with `X-V402-Amount`).
- From the request: `method`, `path` (raw request-target), and the
  validated header values `payer`, `requestId`, `issuedAt`.
- Extensions: the decoded `X-V402-Extensions` block appended verbatim
  after validation.

Consequence: a client that signs values differing from server truth
produces a signature that cannot verify — there is nothing to "trust" in
the request beyond the four request-originated values, each of which is
grammar-validated first.

## 7. Domain-separated balance query

The signed balance query (`GET /v1/balance`,
[`facilitator-api.md`](./facilitator-api.md)) uses its own context line —
a payment signature can never verify as a balance query or vice versa:

```
v402-balance-query/0.1
canonicalDomain: facilitator.example.com
network: vrsctest
payer: v402test.demoAgent@
requestId: 01H8XGABCDEF0123456789QRST
issuedAt: 1783650000
```

Same field grammars as § 3; same LF/no-trailing-newline rules as § 2; no
extension section. Replay protection follows the payment semantics
(`requestId` burned in the same store).

### 7.1 Ledger statement query (additive, 2026-07-14)

The signed ledger query (`GET /v1/ledger`) reuses the balance-query field
set under its own context line — the three read contexts (payment, balance,
ledger) are mutually non-verifiable by construction:

```
v402-ledger-query/0.1
canonicalDomain: facilitator.example.com
network: vrsctest
payer: v402test.demoAgent@
requestId: 01H8XGABCDEF0123456789QRST
issuedAt: 1783650000
```

Pagination parameters (`afterId`, `limit`) are deliberately OUTSIDE the
signature: they select what the authenticated owner sees, never who may
see it, and each signature is single-use via the shared replay store.

## 8. Reference test vectors

[`test-vectors/`](./test-vectors/) is the conformance gate for this
document: `canonical.json` (payload → expected bytes, incl. balance
queries), `extensions.json` (serialize/parse, sort order, reject cases),
`boundary.json` (fail-closed grammar violations, amount edge cases). An
implementation MUST pass all vector cases.
