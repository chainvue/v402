# Reference Test Vectors — v402/0.1

**Status:** placeholder — vectors are generated in Etappe 1, Layer 1 (delivery
plan step 5) by a deterministic script (`scripts/generate-vectors.ts`) using
fixed test keys. Do not hand-edit vector files; regenerate on any spec change.

Normative conformance fixtures: an implementation in any language runs these
and either passes or doesn't. Also published as `@chainvue/v402-test-vectors`.

## Planned categories

| File | Covers |
|---|---|
| `canonical.json` | inputs → expected canonical payload byte-string |
| `signing.json` | inputs + deterministic key → expected signature (RFC 6979)* |
| `verification.json` | signed payloads → expected accept/reject + reason |
| `wire-format.json` | 402 responses, discovery document, facilitator API shapes |
| `extensions.json` | extension canonicalization, sort order, accept/reject semantics |
| `boundary.json` | min/max amounts, unicode identities, boundary `issuedAt`, malformed inputs |

\* Pre-freeze check required: confirm `verusd signmessage` signs
deterministically; if not, signing vectors assert verify-validity instead of
byte-equality.

## Test case structure

```json
{
  "name": "human-readable-id",
  "spec": "v402-prepaid-sig-v0.1",
  "input": { },
  "expected": { }
}
```

Coverage target for v0.1: ~30–50 cases across categories.
