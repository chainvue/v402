# @chainvue/v402-test-vectors

Normative reference test vectors for the [v402 payment protocol](https://github.com/chainvue/v402)
(`verus-prepaid-sig/0.1`). An implementation in any language runs these and
either passes or doesn't — passing all vectors is the baseline for claiming
v402/0.1 conformance (the end-to-end conformance suite is separate, Etappe 1.5).

**License: CC-BY-4.0** — these vectors are part of the v402 spec, not the
Apache-2.0 reference implementation. Reproduce, translate, embed freely with
attribution.

## Categories

| File | Covers |
|---|---|
| `canonical.json` | payload → expected canonical byte-string (payment + balance-query) |
| `extensions.json` | extension-block serialize/parse, sort order, accept/reject |
| `boundary.json` | fail-closed canonicalization errors, amount conversion edges |
| `wire-format.json` | 402 response, discovery document, `X-V402-*` header parsing |
| `signing.json` | canonical string + key → expected signature |
| `verification.json` | (signer, signature, message) → accept/reject |
| `keys.json` | the published test keys (see below) |

## Usage — JavaScript/TypeScript

```typescript
import { loadVectors } from "@chainvue/v402-test-vectors";

for (const { name, input, expected } of loadVectors("canonical").cases) {
  const got = myCanonicalize(input.payload);
  assert.strictEqual(got, expected.canonical, `case ${name} failed`);
}
```

## Usage — any other language

The JSON files are the product; consume them directly from the npm tarball
(`vectors/0.1/*.json`) or from the spec repo (`spec/0.1/test-vectors/`).

```rust
#[test]
fn conformance_canonical() {
    let file = load_json("vectors/0.1/canonical.json");
    for tc in file.cases {
        assert_eq!(my_impl(tc.input), tc.expected, "case {} failed", tc.name);
    }
}
```

Every case has the shape `{ name, spec, input, expected }`.

## Signing vectors & test keys

The signing keys in `keys.json` are **deliberately public** and derived from
documented seeds (`privkey = sha256(utf8(seed))`, WIF = base58check with
prefix `0xBC`, compressed) — re-derivable without trusting this package.
**Never fund the addresses.**

- Cases with `"assert": "signature-equal"` are byte-reproducible: `verusd
  signmessage` signs deterministically (confirmed against v1.2.17).
- Cases with `"assert": "verify-only"` are VerusID signatures, which embed the
  signing block height: validate them via `verifymessage` on VRSCTEST instead
  of byte comparison.

## Versioning

Vectors are versioned with the scheme spec (`vectors/0.1/`). New spec versions
add a directory; existing vectors are immutable per version. Source of truth
is `spec/0.1/test-vectors/` in the monorepo — this package is a packaged copy
kept in sync by its build.
