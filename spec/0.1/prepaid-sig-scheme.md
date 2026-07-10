# Scheme: `verus-prepaid-sig` — version 0.1

**Status:** NORMATIVE for scheme version `verus-prepaid-sig/0.1`.

Verus-native prepaid payment scheme: VerusID identities, off-chain
`signmessage`/`verifymessage`-compatible signatures, prepaid balance funded
by on-chain deposits with sender-VerusID attribution. Builds on the
envelope ([`protocol.md`](./protocol.md)) and the canonical byte format
([`canonical-payload.md`](./canonical-payload.md)).

Registry entry: [`../schemes/registered/verus-prepaid-sig.md`](../schemes/registered/verus-prepaid-sig.md)

## 1. Scheme identifier & versioning

Scheme name: `verus-prepaid-sig`. Current version: `0.1`. Line 1 of every
signed payload is `verus-prepaid-sig/0.1`; the identical token travels in
`X-V402-Scheme` (D1, [`protocol.md`](./protocol.md) § 4). The scheme
versions independently of the protocol.

## 2. Identity model

- `payer` and `payTo` are VerusID friendly names ending in `@`
  (`v402test.demoAgent@`, `explorerAPI@`). Sub-IDs are ordinary payers;
  open registration under a `v402.*@` namespace is a deployment choice,
  not a scheme requirement.
- **Identity-key normalization (normative):** the Verus chain resolves
  identity names case-insensitively. Every component that keys balance
  state (verifier balance lookups, deposit attribution, blocklists) MUST
  key identities by `trim().toLowerCase()` of the friendly name.
  Signature verification is NOT affected — the canonical payload keeps
  the payer string exactly as the client signed it.
- Unknown payers are not auto-created by payment requests: a signed
  request from an identity with no balance row → 402 `no-balance` with
  the deposit address in `error.details`. Identities are auto-provisioned
  only by the deposit watcher on first confirmed deposit (§ 6).

## 3. Signature scheme

Signatures are Verus message signatures over the canonical payload bytes,
transmitted as standard Base64 in `X-V402-Signature`, verified server-side
against the rebuilt canonical string.

**Message hash (both signature forms):**

```
msgHash = SHA-256( compactSize(len(message)) || utf8(message) )
```

This is the `hash` field `verusd signmessage` reports.

**Address signatures** (R-address, `verusd signmessage <R-address>`
compatible) sign the digest

```
addrDigest = SHA-256( compactSize(19) || "Verus signed data:\n" || msgHash )
```

as a 65-byte recoverable compact ECDSA signature (secp256k1, low-S,
header byte `27 + recovery + 4` for compressed keys). In v402, address
signatures verify against an R-address only — the `payer` is an identity
name, so payment signatures use the identity form:

**Identity signatures** (VerusID) sign a digest that additionally binds
the chain, the signing block height, and the identity
(`CIdentitySignature::IdentitySignatureHash`, VERSION_VERUSID, VerusCoin
`src/pbaas/crosschainrpc.cpp`):

```
idDigest = SHA-256( compactSize(19) || "Verus signed data:\n"
                    || systemID(20) || blockHeight(uint32 LE) || idID(20)
                    || msgHash )
```

where `systemID` and `idID` are the raw base58check payloads (20 bytes
each) of the chain's and the identity's i-addresses. The wire form is the
`CIdentitySignature` envelope, Base64 of:

```
0x01 || blockHeight(uint32 LE) || 0x01 || 0x41 || compact65
```

(version 1, one signature, 65-byte entry; multisig identities carry more
entries and MUST satisfy the identity's `minimumsignatures`).

Normative notes, established empirically against `verusd` v1.2.17 and
cross-checked against the VerusCoin sources:

- **Wrapping an address signature in the identity envelope can never
  verify** — the inner compact signature MUST sign `idDigest`.
- **Byte-equality with daemon signatures is not a conformance target:**
  verusd derives its RFC 6979 nonce with a non-standard variant.
  Independent signers produce different, equally valid bytes;
  verification is recovery-based. Conforming signers SHOULD use
  deterministic nonces (plain RFC 6979).
- **Height validity:** verifiers resolve the identity's primary addresses
  AT the embedded height. Heights before the identity's registration are
  rejected; heights after the chain tip are accepted (they resolve to the
  latest identity state). Clients MUST embed a recent height (e.g. from
  the facilitator's health endpoint or `getblockcount`).
- **Verification MUST use the latest identity state** (decision D2):
  daemon-side, `verifymessage <payer> <sig> <canonical> true`
  (`checklatest=true`). With the daemon default (`false`), identity keys
  are resolved at the embedded height, so a compromised-then-rotated key
  could keep producing valid signatures with old heights indefinitely.
  Checking latest state makes revocation and key rotation take effect
  immediately. A signature made moments before a legitimate rotation is
  rejected; the client simply re-signs.
- Base64 is standard-alphabet with padding; base64url MUST be rejected.
  A signature the daemon cannot decode is a semantic reject
  (`invalid-signature`), not a transport error.

## 4. Replay protection

Unique request id + time window (no nonce serialization — parallel
requests are first-class):

- The client generates a fresh ULID `requestId` per request.
- The server accepts iff the signature verifies, `|now − issuedAt| ≤ 300 s`
  (server clocks MUST be NTP-synced; the tolerance is server
  configuration, default 300), and `requestId` was never seen before.
- Accepted request ids are persisted (`spent_requests`); a duplicate →
  409 `replay` with `details.previousStatus`.
- Request ids stay burned within the retention window even when the
  request errors — a client retrying after a definitive error MUST use a
  fresh ULID (§ 7).
- The server MUST retain spent ids for at least
  `max(600 s, 2 × max(reserveTtl, timestampTolerance))` before pruning,
  so the replay window and the reservation reaper can never outlive the
  dedupe horizon.

## 5. Balance model — prepaid, two-phase debit

Balances are prepaid per identity (funded by deposits, § 6) and debited
per request in two phases:

**Phase 1 — verify & reserve (before the endpoint runs):** cheap checks
first (headers → amount byte-comparison (M6) → extensions → timestamp →
blocklist), then the signature RPC, then atomically: insert the request id
(UNIQUE violation → 409 `replay`), lock the balance row, check
`balance ≥ amount` (insufficient → the id is burned as `insufficient`,
402), debit the balance, mark the reservation `reserved`.

**Phase 2 — settle (after the endpoint ran):**

- Response status < 500 → **commit** (`reserved → committed`). A 4xx is a
  rendered, definitive answer — it is charged (Stripe semantics).
- Response status ≥ 500 → **rollback**: refund the reserved amount,
  mark `error`. The request id stays burned.
- Timeout/crash: a reaper refunds reservations older than `reserveTtl`
  (default 300 s; MUST exceed the slowest endpoint's runtime). Commit and
  rollback are strictly conditional state transitions
  (`… WHERE status='reserved'`), so reaper races are deterministic (B3).
- **Late commit:** if a 2xx lands after the reaper already refunded, the
  amount is re-debited and the reservation marked committed; the balance
  MAY go negative (ops flag). Money is never lost, only booked late.

There are no refunds in scheme version 0.1 beyond the rollback/reaper
paths above.

## 6. Deposits

Funding is on-chain: the payer sends `asset` to `payTo` /
`topup.depositAddress` from their VerusID.

- **Attribution — sender-VerusID:** a deposit is credited to the identity
  that funded the transaction's inputs. All identity-funded vins MUST
  resolve to the same identity; mixed identities or plain t-address
  funding → no automatic credit (manual reconciliation). Shielded
  funding cannot be attributed (no transparent vins).
- Identity keys are normalized (§ 2) before crediting; the watcher
  auto-provisions unknown identities on first confirmed deposit.
- **Confirmation depth:** deposits credit after ≥ 10 confirmations
  (deployment-configurable; advertised via the topup instructions
  endpoint).
- **Reorgs:** if a credited deposit's block is reorged away, the credit
  is reversed (balance MAY go temporarily negative if already spent —
  ops review, no automatic blocking: the payer signed against what was a
  valid balance). **Re-mine (M4):** the same tx reappearing in the
  replacement branch is upserted on `(txid, vout)` and follows the normal
  confirmation path to re-credit; every movement is its own ledger row.

## 7. Client retry policy (normative, M5)

Rule of thumb: **no definitive answer → retry with the SAME requestId;
definitive error → FRESH ULID.**

| Situation | Retry with | Why |
|---|---|---|
| Network timeout, no response | same requestId | The client can't know whether it committed; same id either processes fresh or yields 409 with `previousStatus` (`committed` = paid, response lost; `error` = refunded). A fresh ULID risks double-pay |
| 503 `verify-unavailable` | same requestId | Happens before the reserve — nothing was written |
| 429 (throttle) | same requestId | Thrown before payment processing; honor `Retry-After` |
| Endpoint 5xx (rollback ran) | fresh ULID | The old id is burned; retrying it only yields 409. Clients MUST NOT auto-retry endpoint 5xx — whether to re-attempt a possibly side-effectful request is the caller's decision; the table only dictates WHICH id a retry uses |
| 409 `replay` | no retry | That IS the answer — inspect `previousStatus` |
| 402 `insufficient-balance` / `price-mismatch` | fresh ULID after fixing | Top up first / re-sign at the current price (M6 — the 402 body carries the current `accepts`) |

## 8. Extensions

`verus-prepaid-sig/0.1` defines one `scheme.*` extension:

**`scheme.bodyHash`** — binds the payment to the request body:

- Value: `sha256:<64 lowercase hex>` over the **raw request body bytes**.
- Server policy per endpoint: `required | optional | ignored`. A
  body-carrying request against a `required` endpoint without the field →
  400 `body-hash-required`; a malformed value → 400 `invalid-body-hash`;
  a hash mismatch → 400 `body-hash-mismatch`.
- Rationale: single-endpoint protocols (GraphQL, MCP/JSON-RPC) have a
  constant `path` — the request semantics live in the body; without
  `bodyHash` v402 would be de-facto REST-only.

Unknown `scheme.*` keys are rejected ([`protocol.md`](./protocol.md) § 6).

## 9. Error semantics

This scheme uses the shared error catalog
([`facilitator-api.md § Error catalog`](./facilitator-api.md#error-catalog)).
Scheme-relevant specifics:

- `price-mismatch` (402) — signed amount ≠ current price; body carries
  current `accepts` (M6).
- `insufficient-balance` (402) — `details`: `balanceSats`, `requiredSats`,
  `depositAddress`; the request id is burned.
- `no-balance` (402) — payer has no balance row; `details.depositAddress`.
- `invalid-signature` (402) — semantic verification failure (bad
  signature, wrong signer, revoked identity under checklatest, or an
  undecodable signature).
- `unsupported-scheme-version` (400) — the version from `X-V402-Scheme`
  is not enabled; `details.supportedSchemeVersions`.
- `verify-unavailable` (503) — the verification backend is unreachable;
  nothing was reserved; retry with the same id.
- `blocked` (403) — identity is operator-blocked; checked BEFORE the
  signature RPC (blocked identities must not burn verification capacity).

## 10. Reference test vectors

[`test-vectors/`](./test-vectors/): `signing.json` (address + identity
signatures; address cases are byte-reproducible via `assert:
signature-equal`, identity cases are `verify-only` because the embedded
height changes bytes per regeneration), `verification.json`
(accept/reject against the daemon), plus the canonical/extension/boundary
suites shared with [`canonical-payload.md`](./canonical-payload.md). The
vector identity `v402test@` has published test key A as its only primary
address, so any implementer can reproduce the identity cases end-to-end
(`keys.json`).
