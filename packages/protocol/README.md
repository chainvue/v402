# @chainvue/v402-protocol

Protocol core of [v402](https://github.com/chainvue/v402), the Verus-native
payment layer for AI-agent APIs. Types, wire-format schemas (Zod), canonical
payload serialization, amount utilities. Framework-agnostic and browser-safe —
no Node-only APIs, `zod` is the only runtime dependency.

```sh
npm install @chainvue/v402-protocol
```

## What's in here

- `canonicalize()` / `canonicalizeBalanceQuery()` — payload → canonical signing
  string, byte-exact per [`spec/0.1/canonical-payload.md`](https://github.com/chainvue/v402/blob/main/spec/0.1/canonical-payload.md)
- Wire-format schemas: 402 response body, discovery document, `X-V402-*`
  headers (`V402_HEADERS`, `REQUIRED_PAYMENT_HEADERS`)
- Amount utilities: `humanToSats()` / `satsToHuman()` — exact `bigint` sats,
  minimal-decimal human form
- `normalizeIdentityKey()` — chain-relative, case-insensitive identity keying
- `V402ProtocolError` with typed error codes; every validation fails closed

Conformance is defined by the spec plus
[`@chainvue/v402-test-vectors`](https://www.npmjs.com/package/@chainvue/v402-test-vectors) —
this package is the reference implementation of the canonical form.

## License

Apache-2.0. The protocol specification itself is CC-BY-4.0, see the
[spec directory](https://github.com/chainvue/v402/tree/main/spec).
