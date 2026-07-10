# Reference Test Vectors — v402/0.1

Normative conformance fixtures: an implementation in any language runs these
and either passes or doesn't. Generated deterministically by
`scripts/generate-vectors.ts` (repo root) — **do not hand-edit vector files**;
regenerate on any spec change via `pnpm generate:vectors`.

## Categories

| File | Covers | Regeneration |
|---|---|---|
| `canonical.json` | payload → expected canonical byte-string (payment + balance-query) | pure |
| `extensions.json` | extension-block serialize/parse, sort order, accept/reject semantics | pure |
| `boundary.json` | fail-closed canonicalization errors, amount conversion edge cases | pure |
| `wire-format.json` | 402 response, discovery document, `X-V402-*` header parsing | pure |
| `signing.json` | canonical string + key → expected signature | needs VRSCTEST node |
| `verification.json` | (signer, signature, message) → accept/reject | needs VRSCTEST node |

"Pure" categories regenerate without any node. Signing/verification
regeneration needs `VERUS_RPC_URL`, `VERUS_RPC_USER`, `VERUS_RPC_PASS` in the
environment (see `.env.example`); without them the generator keeps the
committed files.

## Test keys — `keys.json`

The signing keys are **deliberately public**. They derive from documented seed
strings, so any implementer can reproduce them without trusting this repo:

```
privkey = sha256(utf8(seed))
WIF     = base58check(0xBC || privkey || 0x01)   # Verus/Komodo prefix, compressed
```

| Key | Seed | Address |
|---|---|---|
| A | `v402-test-vectors/0.1 key A` | `RXzn488JQaeEpo7iezaKiK1XLfRQzi2NWT` |
| B | `v402-test-vectors/0.1 key B` | `RLjrXPziU4Moc13vc2vGMvNpMmfM7ozZir` |

**Never fund these addresses** — anything sent there is publicly spendable.

## Determinism (pre-freeze check, resolved)

Checked against `verusd` v1.2.17 on VRSCTEST (2026-07-10):

- **Address-key `signmessage` is deterministic** — repeat signing of the same
  message (incl. multiline canonical payloads) yields byte-identical
  signatures. Signing vectors with `"assert": "signature-equal"` therefore
  freeze byte-equality — **for daemon regeneration**. Third-party signer
  implementations should NOT assert byte-equality against these signatures:
  verusd derives its RFC 6979 nonce with a non-standard variant, so an
  independent correct signer produces different (equally valid) bytes.
  Assert instead that (a) your message hash matches `expected.hash`, and
  (b) your signature verifies — offline via pubkey recovery over the sign
  digest, or authoritatively via `verifymessage`. The digest pipeline is:
  `msgHash = sha256(compactSize(len) || message)`;
  `signDigest = sha256(compactSize(19) || "Verus signed data:\n" || msgHash)`.
- **Identity signatures sign a DIFFERENT digest** than address signatures
  (confirmed against `CIdentitySignature::IdentitySignatureHash`, VerusCoin
  `src/pbaas/crosschainrpc.cpp`, VERSION_VERUSID path): it additionally binds
  the chain and the identity —
  `idDigest = sha256(compactSize(19) || "Verus signed data:\n" || systemID(20) || height(LE32) || idID(20) || msgHash)`
  where systemID/idID are the raw base58check payloads of the chain and
  identity i-addresses. The wire form is the CIdentitySignature envelope:
  `0x01 || height(LE32) || 0x01 || 0x41 || compact65`. Verification resolves
  the identity's primary addresses AT the embedded height: heights before the
  identity's registration are rejected; future heights are accepted (resolve
  to the identity's latest state).
- **VerusID signatures embed the signing block height** (bytes 1–4 of the
  decoded signature), so re-signing at a later height changes the bytes while
  remaining valid. Identity cases carry `"assert": "verify-only"`: validate
  them via `verifymessage`. The vector identity `v402test@` has the published
  test key A as its primary address, so any implementer can sign as
  `v402test@` and reproduce these cases end-to-end (revocation/recovery stay
  steward-controlled). Never fund the identity.

## Test case structure

```json
{
  "name": "human-readable-id",
  "spec": "verus-prepaid-sig-v0.1",
  "input": { },
  "expected": { }
}
```

## CI gate

`packages/protocol/test/vectors.test.ts` runs every vector against the
reference implementation on each test run. Cryptographic checks of
signing/verification vectors run in the RPC-gated integration suite (Layer 2+,
gated behind `VERUS_RPC_URL`).
