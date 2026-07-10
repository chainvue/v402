# v402 Core Protocol — v402/0.1

**Status:** NORMATIVE for protocol version `v402/0.1`.

This document governs the protocol **envelope**: everything
scheme-independent — discovery, the 402 response, request headers, version
negotiation, extension mechanics, and the trust model. Individual payment
schemes build on top of it; the initial scheme is
[`prepaid-sig-scheme.md`](./prepaid-sig-scheme.md). The exact byte format of
signed payloads is specified in
[`canonical-payload.md`](./canonical-payload.md). The facilitator HTTP
surface (including the authoritative error catalog) is specified in
[`facilitator-api.md`](./facilitator-api.md).

## 1. Terminology & conformance language

The key words MUST, MUST NOT, REQUIRED, SHALL, SHALL NOT, SHOULD, SHOULD
NOT, RECOMMENDED, MAY, and OPTIONAL are to be interpreted as described in
RFC 2119 and RFC 8174 when, and only when, they appear in all capitals.

- **Server** — the API being paid for (usually via a v402 middleware).
- **Client** — the paying caller (agent, SDK, `fetch` wrapper).
- **Facilitator** — the payment-infrastructure service holding balance
  state and verifying signatures (may run in-process with the server).
- **Scheme** — a concrete payment mechanism (signature format, balance
  semantics) identified by a scheme name, versioned independently of the
  protocol.
- **Protocol version** — the envelope version, e.g. `v402/0.1`.
- **Scheme version** — one scheme's version, e.g. `verus-prepaid-sig/0.1`.

Unknown JSON fields: consumers of every wire object defined here MUST
ignore fields they do not recognize (MINOR versions add optional fields).

## 2. Discovery — `GET /.well-known/v402`

Servers SHOULD expose a discovery document. Facilitators MUST expose one.

```json
{
  "specUrl": "https://v402.dev/spec/",
  "supportedVersions": ["v402/0.1"],
  "defaultVersion": "v402/0.1",
  "deprecatedVersions": [],
  "sunsetDates": {},
  "supportedExtensions": ["scheme.bodyHash"]
}
```

- `supportedVersions` (REQUIRED, non-empty) — protocol versions the server
  speaks.
- `defaultVersion` (REQUIRED) — the version used when the client expresses
  no preference. MUST be a member of `supportedVersions`.
- `specUrl` (OPTIONAL) — human-readable spec location.
- `deprecatedVersions` (OPTIONAL) — versions that still work but are
  scheduled for removal.
- `sunsetDates` (OPTIONAL) — map of version → ISO 8601 date after which the
  server MAY remove support. Servers MUST announce sunsets at least 6
  months in advance.
- `supportedExtensions` (OPTIONAL) — extension keys (or `prefix.*`
  wildcards) the server understands. Clients MUST NOT send extensions the
  server does not advertise, except `x-<vendor>.*` (which servers ignore,
  § 6).

## 3. The 402 response

A protected endpoint hit without (valid) payment MUST answer
`402 Payment Required` with `Content-Type: application/json`:

```json
{
  "version": "v402/0.1",
  "accepts": [
    {
      "scheme": "verus-prepaid-sig",
      "schemeVersion": "0.1",
      "network": "vrsctest",
      "asset": "VRSCTEST",
      "amount": "0.001",
      "amountUnit": "human",
      "payTo": "explorerAPI@",
      "facilitator": "https://facilitator.example.com",
      "requiredHeaders": ["X-V402-Scheme", "X-V402-Payer", "X-V402-Amount", "X-V402-Request-Id", "X-V402-Issued-At", "X-V402-Signature"],
      "canonicalDomain": "explorer.example.com",
      "topup": { "depositAddress": "explorerAPI@", "attribution": "sender-verusid" }
    }
  ]
}
```

- `version` (REQUIRED) — the protocol version of this envelope.
- `accepts` (REQUIRED) — one entry per accepted scheme; multi-entry from
  day 1. Clients MUST skip entries whose `scheme` they do not implement.
- Per entry: `scheme`, `schemeVersion`, `network`, `asset`, `amount`,
  `amountUnit`, `payTo`, `facilitator`, `requiredHeaders` (non-empty),
  `canonicalDomain` are REQUIRED; `topup` is OPTIONAL. Field semantics
  beyond the envelope (e.g. `payTo` being a VerusID) belong to the scheme
  document.
- `amount` is a decimal string (grammar in
  [`canonical-payload.md`](./canonical-payload.md) § 3); `amountUnit` MUST
  be `"human"` in v402/0.1. Amounts are never JSON numbers.
- When a 402 is a **rejection** rather than a first challenge, the body
  additionally carries `error: { code, message, details? }` with a code
  from the error catalog (§ 8), e.g. `price-mismatch` — and the `accepts`
  array reflects the CURRENT price so clients can self-heal (M6).

## 4. Request headers

A payment request carries these headers (all REQUIRED unless stated):

| Header | Content |
|---|---|
| `X-V402-Scheme` | `<scheme>/<schemeVersion>` — byte-identical to line 1 of the signed payload (see below) |
| `X-V402-Payer` | the paying identity, exactly as signed |
| `X-V402-Amount` | the amount string the client signed (from the 402 it acted on) |
| `X-V402-Request-Id` | ULID, fresh per request |
| `X-V402-Issued-At` | Unix seconds (decimal integer, no leading zeros) |
| `X-V402-Signature` | standard Base64 (`+/=`), scheme-defined signature |
| `X-V402-Extensions` | OPTIONAL — base64 of the signed extension block (§ 6) |

- **`X-V402-Scheme` (D1):** clients conforming to v402/0.1 MUST send the
  versioned form `<scheme>/<schemeVersion>` (e.g.
  `verus-prepaid-sig/0.1`), mirroring the signed payload's line 1 byte for
  byte. Servers MUST accept a bare scheme name and treat it as that
  scheme's default version (compatibility); a version-mismatched client
  sending the bare form then surfaces as `invalid-signature` instead of
  the speaking `unsupported-scheme-version`.
- A payment header MUST NOT repeat. Servers MUST reject requests with
  repeated payment headers (never pick one of two values).
- `X-V402-Amount` is compared byte-verbatim against the current price
  BEFORE any signature check; mismatch → 402 `price-mismatch` with the
  current `accepts` in the body.
- Base64 is standard-alphabet with padding; base64url MUST be rejected.

## 5. Version negotiation

Two independent version namespaces (M2):

- **Protocol version** (`v402/0.1`) governs the envelope: 402 shape,
  discovery, header names, extension mechanics. Advertised in
  `supportedVersions`.
- **Scheme version** (`verus-prepaid-sig/0.1`) governs one scheme's
  canonical payload and verification semantics. Advertised per scheme as
  `schemeVersion` in each `accepts` entry; declared by the client as
  payload line 1 AND in `X-V402-Scheme`.

Negotiation:

1. The client learns the server's protocol versions (discovery) and
   per-scheme versions (`accepts`).
2. The client picks the highest protocol version both sides speak; no
   overlap → client-side error. Same logic per scheme.
3. The signed payload declares the chosen scheme version on line 1; the
   identical token travels in `X-V402-Scheme`.
4. Servers check the two levels separately. The scheme version (from
   `X-V402-Scheme`) not being enabled → 400 `unsupported-scheme-version`,
   with the accepted versions listed in `error.details`. The protocol
   version is not transmitted in requests in v402/0.1 — the header set
   itself implies it, and exactly one protocol version exists; the error
   code `unsupported-version` is reserved for future envelope MAJORs where
   a request-level protocol-version token becomes necessary.

Semver for the wire format:

- **PATCH** (`0.1.1`) — clarifications only; no version bump in payloads.
- **MINOR** (`0.1 → 0.2`) — new optional fields/schemes, backward
  compatible; servers MUST remain compatible with prior MINOR versions.
- **MAJOR** — breaking wire change; servers MAY run multiple MAJOR
  versions in parallel but are not required to.

Deprecation is signaled via `deprecatedVersions`/`sunsetDates` (§ 2).

## 6. Extension mechanics

Extensions are additional signed fields after the fixed core of the
canonical payload (byte rules in
[`canonical-payload.md`](./canonical-payload.md) § 5).

**Key grammar (normative):** an extension key is `<prefix>.<field>` where

```
prefix = "scheme" | "iana" | "x-" 1*(lowercase-alnum) *("-" 1*(lowercase-alnum))
field  = ALPHA *(ALPHA / DIGIT)          ; single segment, camelCase by convention
```

i.e. it MUST match `^(?:scheme|iana|x-[a-z0-9]+(?:-[a-z0-9]+)*)\.[A-Za-z][A-Za-z0-9]*$`.

- `scheme.<field>` — defined by the active scheme (e.g. `scheme.bodyHash`).
- `x-<vendor>.<field>` — vendor-custom, opaque to servers.
- `iana.<field>` — reserved for a future v402 registry; MUST NOT be used
  until registered.

**Value rules (normative):** values MUST be non-empty, MUST NOT contain CR
or LF, and MUST NOT start with a space. (This makes `key: value` lines
byte-unambiguous to parse.)

**Wire transmission (B2):** all extension fields travel in ONE header:

```
X-V402-Extensions: base64(<extension lines exactly as signed>)
```

The decoded value MUST be byte-identical to the signed extension section:
LF-separated `key: value` lines, keys strictly ascending bytewise, no
trailing newline, no duplicate keys. Decoded size limit: **4096 bytes** →
400 `extensions-too-large`. Header absent = no extension section.

**Server behavior for unknown extensions:**

| Prefix | Unknown key |
|---|---|
| `scheme.*` | **REJECT** (400 `unknown-scheme-extension`) — the scheme must know the field to verify it semantically |
| `x-*` | **ACCEPT and IGNORE** — still part of the signed bytes |
| `iana.*` | **REJECT** (400 `reserved-extension`) until registered |

## 7. Scheme namespace registry

Scheme names MUST match `^[a-z0-9]+(?:-[a-z0-9]+)*$` and follow
`<network-family>-<mechanism>` (registered) or `x-<vendor>-<mechanism>`
(vendor-custom, no registration). Reserved network-family prefixes and the
registration process are maintained in [`../schemes/`](../schemes/).

## 8. Error catalog

Machine-readable error identifiers and their HTTP status classes are
maintained normatively in
[`facilitator-api.md § Error catalog`](./facilitator-api.md#error-catalog);
those `error.code` values are stable public contract — renaming one is a
breaking change. Error envelope everywhere:
`{ "ok": false, "error": { "code", "message", "details"? } }`, except
402 rejections, which use the 402 body of § 3 (with `error` embedded).

## 9. Trust model & transport security

The discovery document and the 402 response are **unauthenticated**. HTTPS
is REQUIRED in production: a MITM could otherwise swap
`payTo`/`depositAddress`, and on-chain deposits are irreversible.

Clients SHOULD pin `payTo` for known services (warn or abort when it
changes) and SHOULD verify deposit targets out-of-band on first use.
Path-rewriting proxies in front of a v402-protected server are unsupported
(see the `path` verbatim rule,
[`canonical-payload.md`](./canonical-payload.md) § 4).

## 10. Reference test vectors

Conformance fixtures for the envelope (`wire-format.json`: 402 envelope,
discovery, header parsing) live in [`test-vectors/`](./test-vectors/).
