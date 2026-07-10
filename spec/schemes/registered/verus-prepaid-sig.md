# verus-prepaid-sig

| | |
|---|---|
| **Scheme name** | `verus-prepaid-sig` |
| **Current version** | 0.1 (draft) |
| **Status** | draft — first implemented scheme of v402/0.1 |
| **Steward** | chainvue (Robert Lech) |
| **Normative spec** | [`spec/0.1/prepaid-sig-scheme.md`](../../0.1/prepaid-sig-scheme.md) |
| **Canonical payload** | [`spec/0.1/canonical-payload.md`](../../0.1/canonical-payload.md) |
| **Test vectors** | [`spec/0.1/test-vectors/`](../../0.1/test-vectors/) |
| **Reference implementation** | `@chainvue/v402-*` packages (this repository) |

Verus-native prepaid payment scheme: VerusID identity, off-chain
`signmessage`/`verifymessage` signatures for zero-latency per-request
authentication, prepaid balance funded via on-chain deposits with
sender-VerusID attribution.

## Version history

| Version | Date | Notes |
|---|---|---|
| 0.1 | 2026 (draft) | Initial scheme; ships with v402/0.1 MVP |
