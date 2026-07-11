# @chainvue/v402-conformance-suite

Conformance runner for [v402](https://github.com/chainvue/v402)
implementations: drives any implementation through the normative reference
test vectors ([`@chainvue/v402-test-vectors`](https://www.npmjs.com/package/@chainvue/v402-test-vectors))
and reports pass/fail per case. Passing all applicable vectors is the baseline
for claiming v402/0.1 conformance.

```sh
npm install --save-dev @chainvue/v402-conformance-suite
```

```ts
import { runConformance, formatReport, referenceTarget } from "@chainvue/v402-conformance-suite";

// adapt YOUR implementation to the ConformanceTarget interface:
const report = await runConformance(myTarget);
console.log(formatReport(report));
if (!report.ok) process.exit(1);
```

## The target interface

Every operation is optional — categories whose operations are missing are
reported as **skipped**, so a client-only or server-only implementation can
prove conformance for exactly what it implements. Where a vector expects a
rejection, the operation must throw an error whose `code` equals the vector's
error identifier (the identifiers are normative).

Signing cases follow the vectors' documented semantics: independent
implementations assert the message hash and verify-validity of both the
reference signature and their own — not byte-equality, which only the daemon's
RFC 6979 nonce variant can reproduce.

Identity-signature cases are verified against the pinned `v402test@` state
shipped with the vectors (published test key A as the only primary address),
so no chain access is needed anywhere in a conformance run.

`referenceTarget()` wires this repository's own packages to the interface —
it doubles as the self-conformance gate in CI and as adaptation template.

Cross-language targets (subprocess/CLI protocol) are on the roadmap (Etappe 2);
until then, non-JS implementations consume the vector JSON directly.

## License

Apache-2.0
