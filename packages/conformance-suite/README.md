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

## Non-JS implementations: the `v402-conformance` CLI

Implementations in any language prove conformance without JS bindings: expose
the operations over a line-delimited JSON protocol on stdin/stdout and let the
CLI drive them.

```sh
npx v402-conformance [--strict] [--categories a,b] [--timeout ms] -- ./my-impl-conformance
```

Exit codes: `0` conformant · `1` failed cases (with `--strict`, skips too) ·
`2` usage/transport error.

### Wire protocol (NDJSON)

One JSON document per line. The runner sends requests on the child's stdin;
the child answers on stdout (stdout is RESERVED for protocol lines — logs go
to stderr). The first request is a handshake:

```
→ {"id": 1, "op": "hello"}
← {"id": 1, "ok": true, "result": {"name": "my-impl", "ops": ["canonicalize", "humanToSats"]}}
```

Only declared ops are exercised; everything else is skipped. Operations,
their `args` object and `result` mirror the `ConformanceTarget` interface:

| op | args | result |
|---|---|---|
| `canonicalize` | `{payload, payloadType}` | canonical string |
| `serializeExtensions` | `{fields: [{key, value}]}` | extension block string |
| `parseExtensions` | `{block}` | `[{key, value}]` |
| `humanToSats` | `{human}` | sats decimal string |
| `satsToHuman` | `{sats}` | human decimal string |
| `validateWireFormat` | `{type, value}` | `{valid, claim?}` |
| `messageHash` | `{message}` | hex string |
| `signMessage` | `{message, wif}` | base64 compact signature |
| `verifyMessage` | `{message, signature, signer, identity?}` | boolean |

Success: `{"id": n, "ok": true, "result": …}`. Rejection:

```
← {"id": 3, "ok": false, "error": {"code": "invalid-amount", "message": "…"}}
```

Where a vector expects an error, `error.code` MUST equal the vector's error
identifier — the identifiers are normative. `verifyMessage` receives the
pinned identity state for `…@` signers as `args.identity`
(`{name, identityAddress, systemId, primaryAddresses, minimumSignatures}`).

A working example child (backed by the reference implementation) lives at
[`test/fixtures/reference-child.mjs`](https://github.com/chainvue/v402/blob/main/packages/conformance-suite/test/fixtures/reference-child.mjs);
the CI suite drives the full vector set through it — zero skips — to keep the
transport honest.

## License

Apache-2.0
