# @chainvue/v402-conformance-suite

Conformance runner for [v402](https://github.com/chainvue/v402) implementations: drives any implementation through the normative reference test vectors ([`@chainvue/v402-test-vectors`](https://www.npmjs.com/package/@chainvue/v402-test-vectors)) and reports pass/fail per case. Passing all applicable vectors is the baseline for claiming v402/0.1 conformance.

```sh
npm install --save-dev @chainvue/v402-conformance-suite
```

```ts
import { runConformance, formatReport } from "@chainvue/v402-conformance-suite";

const report = await runConformance(myTarget); // adapt YOUR impl to ConformanceTarget
console.log(formatReport(report));
if (!report.ok) process.exit(1);
```

## How it works

- Adapt your implementation to the `ConformanceTarget` interface. Every operation is optional — categories whose operations are missing are reported **skipped**, so a client-only or server-only impl proves exactly what it implements.
- Where a vector expects a rejection, the operation must throw an error whose `code` equals the vector's (normative) error identifier.
- Signing/identity cases assert message-hash and verify-validity against pinned `v402test@` state shipped with the vectors — no chain access anywhere in a run, not byte-equality (only the daemon's RFC 6979 nonce variant reproduces that).
- `referenceTarget()` wires this repo's own packages to the interface — the CI self-conformance gate and an adaptation template.

## Non-JS implementations: the `v402-conformance` CLI

Expose your operations over a line-delimited JSON protocol on stdin/stdout; the CLI drives them.

```sh
npx v402-conformance [--strict] [--categories a,b] [--timeout ms] -- ./my-impl-conformance
```

Exit codes: `0` conformant · `1` failed cases (with `--strict`, skips too) · `2` usage/transport error.

### Wire protocol (NDJSON)

One JSON document per line; stdout is reserved for protocol lines (logs → stderr). The first request is a handshake:

```
→ {"id": 1, "op": "hello"}
← {"id": 1, "ok": true, "result": {"name": "my-impl", "ops": ["canonicalize", "humanToSats"]}}
```

Only declared ops run. Each op's `args`/`result` mirror `ConformanceTarget`:

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

Success `{"id": n, "ok": true, "result": …}`; rejection `{"id": n, "ok": false, "error": {"code", "message"}}`, where `error.code` MUST equal the vector's error identifier. `verifyMessage` receives the pinned identity state for `…@` signers as `args.identity`. A working reference child lives at [`test/fixtures/reference-child.mjs`](https://github.com/chainvue/v402/blob/main/packages/conformance-suite/test/fixtures/reference-child.mjs).

## License

Apache-2.0
