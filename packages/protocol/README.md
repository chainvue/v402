# @chainvue/v402-protocol

Protocol core of [v402](https://github.com/chainvue/v402), the Verus-native payment layer for AI-agent APIs: types, Zod wire schemas, canonical payload serialization, amount math. Framework-agnostic, browser-safe; `zod` is the only dependency.

```sh
npm install @chainvue/v402-protocol
```

```ts
import { humanToSats, satsToHuman, canonicalize } from "@chainvue/v402-protocol";

humanToSats("0.001"); // 100000n — exact bigint sats, never floats
satsToHuman(100000n); // "0.001" — minimal human form

const signingString = canonicalize(payload); // byte-exact canonical string
```

## What it does

- `humanToSats` / `satsToHuman` — exact `bigint` sats ⇄ human decimal strings
- `canonicalize()` / `canonicalizeBalanceQuery()` — byte-exact signing strings ([`spec/0.1/canonical-payload.md`](https://github.com/chainvue/v402/blob/main/spec/0.1/canonical-payload.md))
- Zod wire schemas — 402 response, discovery document, `X-V402-*` headers (`parsePaymentHeaders`)
- `normalizeIdentityKey()` — chain-relative, case-insensitive identity keys
- `V402ProtocolError` with typed error codes; every validator fails closed

## Good to know

- No Node-only APIs — runs in browsers and edge runtimes.
- Reference implementation of the canonical form; conformance is defined by the spec plus [`@chainvue/v402-test-vectors`](https://www.npmjs.com/package/@chainvue/v402-test-vectors).

## License

Apache-2.0. The protocol specification itself is CC-BY-4.0 ([spec/](https://github.com/chainvue/v402/tree/main/spec)).
