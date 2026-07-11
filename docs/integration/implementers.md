# Building a v402 implementation (any language)

How to implement v402/0.1 in Rust, Go, Python, … and prove conformance. This
guide is a map — the normative sources it points to always win:

| Source | Role |
|---|---|
| [`spec/0.1/protocol.md`](../../spec/0.1/protocol.md) | handshake, headers, retry matrix, error catalog pointers |
| [`spec/0.1/canonical-payload.md`](../../spec/0.1/canonical-payload.md) | the byte-exact string that gets signed |
| [`spec/0.1/prepaid-sig-scheme.md`](../../spec/0.1/prepaid-sig-scheme.md) | Verus crypto: digests, envelope, verification rules |
| [`spec/0.1/facilitator-api.md`](../../spec/0.1/facilitator-api.md) | facilitator HTTP contract (normative prose) |
| [`spec/0.1/facilitator-api.openapi.yaml`](../../spec/0.1/facilitator-api.openapi.yaml) | the same contract, machine-readable (CI-validated against the reference) |
| [`spec/0.1/test-vectors/`](../../spec/0.1/test-vectors/) | 70+ reference vectors — your acceptance tests |

## 1. Decide what you are building

You do not need all of it. The conformance runner skips what you don't
declare — partial implementations are first-class:

- **Client / signer** (an agent that pays): canonical payload construction,
  amount formatting, extension serialization, address- and identity-mode
  signing, the 402 handshake and retry rules (M5/M6).
- **Server / verifier** (an API that charges): header parsing, canonical
  payload REconstruction, signature verification (RPC-mode via a Verus node,
  or offline via recovery), replay protection, two-phase debit.
- **Full facilitator**: the above plus the HTTP API, balance state, deposit
  watching — implement against the OpenAPI document and mirror the error
  catalog exactly (the `error.code` identifiers are stable wire contract).

## 2. The parts that bite (read before coding)

All normative detail is in `prepaid-sig-scheme.md`; these are the mistakes
the reference implementation already made for you:

- **Two different digests.** An address signature signs
  `sha256(ser("Verus signed data:\n") ‖ msgHash)` where
  `msgHash = sha256(compactSize ‖ message)`. An IDENTITY signature signs a
  DIFFERENT digest that additionally binds the chain (`systemID`), the
  signing block height, and the identity's i-address. Wrapping an address
  signature in the identity envelope can never verify.
- **The identity envelope** is
  `0x01 ‖ height_le32 ‖ compactSize(numSigs) ‖ (0x41 ‖ compact65)*` — one
  65-byte recoverable compact signature per key for N-of-M.
- **Verification is recovery-based.** Recover the public key from each
  compact signature, hash160 it, and count DISTINCT matches against the
  identity's `primaryaddresses`; require `minimumsignatures`, reject revoked
  identities. Never compare signature bytes against the daemon's — verusd
  uses a non-standard RFC 6979 nonce variant, so byte-equality with your
  signer is unattainable and irrelevant.
- **Latest state, embedded height.** Evaluate key material
  (`primaryaddresses`, `minimumsignatures`, revocation) from the LATEST
  identity state, but compute the digest with the height EMBEDDED in the
  signature (`checklatest=true` parity). Otherwise a compromised-then-rotated
  key verifies forever via old heights.
- **Canonical payload is byte-exact.** Amounts in minimal decimal form,
  extension keys in the frozen grammar, `payer` cased as signed but the
  balance ACCOUNT keyed by the lowercased chain-relative name
  (`normalizeIdentityKey`). Reconstruct — never trust — the canonical string
  server-side.

## 3. Test vectors

[`spec/0.1/test-vectors/`](../../spec/0.1/test-vectors/) ships six
categories (`canonical`, `extensions`, `boundary`, `wire-format`, `signing`,
`verification`) plus `keys.json`:

- The test keys are PUBLIC by design (re-derivable from documented seeds) —
  **never fund them**. `v402test@` (primary = published key A) exists on
  VRSCTEST so anyone can reproduce the identity cases; `keys.json` pins its
  state incl. `systemid`, so **no chain access is needed** for a conformance
  run. For exercising the N-of-M path live, `v402multisig@` (2-of-2 over
  keys A+B, same caveats) is registered on VRSCTEST as well.
- `assert: "signature-equal"` cases are byte-reproducible from the WIF
  (daemon-deterministic address signatures). `assert: "verify-only"` cases
  (VerusID) embed a block height — assert hash match and verify-validity of
  the reference signature AND your own, not byte-equality.
- Error cases assert `code` identifiers exactly — they are normative.

## 4. Prove it: the conformance suite

Expose your implementation over a tiny NDJSON stdin/stdout protocol (a
`hello` handshake declaring which of the nine operations you implement, then
request/response pairs — full op table in the
[`@chainvue/v402-conformance-suite` README](../../packages/conformance-suite/README.md)),
then let the CLI drive it:

```sh
npx v402-conformance -- ./my-impl-conformance          # skips what you don't declare
npx v402-conformance --strict -- ./my-impl-conformance # full-conformance gate
```

Exit 0 = conformant. A working example child (JS, backed by the reference
implementation) lives at
[`packages/conformance-suite/test/fixtures/reference-child.mjs`](../../packages/conformance-suite/test/fixtures/reference-child.mjs).
JS/TS implementations can skip the subprocess protocol and implement the
`ConformanceTarget` interface directly.

**Claiming conformance:** all applicable vectors pass (`--strict` for full
implementations); for facilitators additionally the OpenAPI contract and the
error catalog. Wire-format ambiguities are spec bugs — open an issue instead
of guessing.

## 5. Live testing on VRSCTEST

For end-to-end runs against a real chain you need a `verusd` testnet node.
The reference repo's gated integration suites (`VERUS_RPC_URL` env) and the
compose smoke (`pnpm smoke`) show the pattern; `v402-agent@` /
`v402-facilitator@` are the reference demo identities. Registration of your
own identities costs testnet VRSCTEST (faucet/mining/ask in the Verus
discord).
