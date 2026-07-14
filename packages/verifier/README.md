# @chainvue/v402-verifier

Framework-agnostic verification core of [v402](https://github.com/chainvue/v402): a multi-scheme `VerifierRegistry` and the `verus-prepaid-sig/0.1` verifier. Runs the full server-side pipeline — header parsing, amount pre-check, extension + bodyHash policy, timestamp window, blocklist, signature verification, and two-phase debit (reserve → commit/rollback) against injected storage.

```sh
npm install @chainvue/v402-verifier
```

Most integrators consume this through the [facilitator daemon](https://www.npmjs.com/package/@chainvue/v402-facilitator) or the [NestJS adapter](https://www.npmjs.com/package/@chainvue/v402-nestjs) rather than directly.

## What it does

- `VerifierRegistry` — dispatch by scheme header (`parseSchemeHeader`)
- `VerusPrepaidSigVerifier` — the reference scheme verifier (RPC mode: `verifymessage` with `checklatest=true`)
- `HttpFacilitatorVerifier` — verify against a remote facilitator over HTTP
- `CachedIdentityProvider` — cached VerusID state resolution
- `build402Body()` — construct the 402 challenge body from an advertisement

## Good to know

- Requires an injected `IStorage` ([`@chainvue/v402-storage`](https://www.npmjs.com/package/@chainvue/v402-storage)) and Verus RPC client ([`@chainvue/v402-verus-rpc`](https://www.npmjs.com/package/@chainvue/v402-verus-rpc)).
- `VerifyErrorCode` values and their HTTP status mapping are a frozen wire contract — see the error catalog in [`spec/0.1/facilitator-api.md`](https://github.com/chainvue/v402/blob/main/spec/0.1/facilitator-api.md).

## License

Apache-2.0
