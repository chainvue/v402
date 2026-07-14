# @chainvue/v402-test-vectors

Normative reference test vectors for the [v402 payment protocol](https://github.com/chainvue/v402) (`verus-prepaid-sig/0.1`). JSON fixtures any implementation runs to prove v402/0.1 conformance — in any language.

**License: CC-BY-4.0** — these vectors are part of the v402 spec, not the Apache-2.0 reference implementation. Reproduce, translate, embed freely with attribution.

```sh
npm install @chainvue/v402-test-vectors
```

```ts
import { loadVectors } from "@chainvue/v402-test-vectors";

for (const { name, input, expected } of loadVectors("canonical").cases) {
  assert.strictEqual(myCanonicalize(input.payload), expected.canonical, name);
}
```

Not using JS? The JSON files are the product — consume them directly from the npm tarball (`vectors/0.1/*.json`) or the spec repo (`spec/0.1/test-vectors/`). Every case has the shape `{ name, spec, input, expected }`.

## Categories

| File | Covers |
|---|---|
| `canonical` | payload → expected canonical byte-string (payment + balance-query) |
| `extensions` | extension-block serialize/parse, sort order, accept/reject |
| `boundary` | fail-closed canonicalization errors, amount conversion edges |
| `wire-format` | 402 response, discovery document, `X-V402-*` header parsing |
| `signing` | canonical string + key → expected signature |
| `verification` | (signer, signature, message) → accept/reject |
| `keys` | the published test keys |

## Good to know

- Test keys in `keys.json` are **deliberately public**, re-derivable from documented seeds (`privkey = sha256(utf8(seed))`, WIF base58check prefix `0xBC`, compressed) — no trust in this package required. **Never fund the addresses.**
- `signature-equal` cases are byte-reproducible (`verusd signmessage` is deterministic, confirmed against v1.2.17). `verify-only` cases are VerusID signatures — validate via `verifymessage` on VRSCTEST, not byte comparison.
- Vectors are versioned with the scheme spec (`vectors/0.1/`) and immutable per version; new spec versions add a directory. Source of truth is `spec/0.1/test-vectors/` in the monorepo.

## License

CC-BY-4.0
