# v402 Protocol Specification

Normative specification of the v402 payment protocol — an HTTP-402-based handshake
that lets APIs charge clients (in particular AI agents) per-request using
blockchain-native payment schemes.

This directory is the **standards track**. It is licensed [CC-BY-4.0](./LICENSE),
separately from the reference implementation (Apache-2.0, see repo root).
Anyone may implement v402 in any language from these documents plus the
reference test vectors.

## Versions

| Version | Status | Documents |
|---|---|---|
| **v402/0.1** | Normative (frozen 2026-07-10) | [`0.1/`](./0.1/) |

A protocol version governs the envelope (402 response shape, discovery format,
header names, extension mechanics). Payment **schemes** version independently —
each `accepts` entry advertises its own `schemeVersion`. See
[`0.1/protocol.md`](./0.1/protocol.md) § Version Negotiation.

## Documents (v402/0.1)

- [`0.1/protocol.md`](./0.1/protocol.md) — core protocol: discovery, 402 handshake, headers, version negotiation, extension mechanics
- [`0.1/prepaid-sig-scheme.md`](./0.1/prepaid-sig-scheme.md) — the `verus-prepaid-sig` scheme (normative)
- [`0.1/canonical-payload.md`](./0.1/canonical-payload.md) — wire format + canonicalization rules
- [`0.1/facilitator-api.md`](./0.1/facilitator-api.md) — facilitator HTTP API
- [`0.1/test-vectors/`](./0.1/test-vectors/) — JSON reference test vectors (conformance gate)

## Scheme registry

Scheme names are namespaced (`verus-*`, `evm-*`, …, or `x-<vendor>-*` for
vendor-custom). See [`schemes/README.md`](./schemes/README.md) for the registry
model and registration process.

## Governance

BDFL model during v0.x, stewarded by chainvue (Robert Lech), with a documented
transition to a Technical Steering Committee. Change-proposal process, semver
rules, and deprecation policy: [`governance.md`](./governance.md).
