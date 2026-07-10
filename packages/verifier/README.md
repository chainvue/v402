# @chainvue/v402-verifier

Framework-agnostic verification core of
[v402](https://github.com/chainvue/v402): a multi-scheme `VerifierRegistry` and
the `verus-prepaid-sig/0.1` verifier. Implements the full server-side pipeline
from [`spec/0.1/prepaid-sig-scheme.md`](https://github.com/chainvue/v402/blob/main/spec/0.1/prepaid-sig-scheme.md):
header parsing, amount pre-check, extension validation, bodyHash policy,
timestamp window, blocklist, signature verification (RPC mode, `verifymessage`
with `checklatest=true`), and the two-phase debit (reserve → commit/rollback)
against injected storage.

Consumed by the facilitator daemon and the NestJS adapter's in-process mode;
integrators normally use those rather than this package directly. Etappe 1.5
adds an offline (RPC-less) verification mode.

```sh
npm install @chainvue/v402-verifier
```

The 21 `VerifyErrorCode` values and their HTTP status mapping are frozen wire
contract — see the error catalog in
[`spec/0.1/facilitator-api.md`](https://github.com/chainvue/v402/blob/main/spec/0.1/facilitator-api.md).

## License

Apache-2.0
