# v402 — Verus-Native Payment Layer for AI-Agent APIs

v402 is a payment protocol and reference implementation that lets APIs charge AI agents
per-request using Verus-native currencies. It borrows the HTTP-402 handshake pattern from
Coinbase's x402 spec but replaces the EVM payment layer with a Verus-native scheme
(`verus-prepaid-sig`): VerusID for identity, off-chain signatures for zero-latency
authentication, and a prepaid balance model for near-zero per-request cost.

**Status: pre-alpha — Etappe 1 (MVP) in progress.** Nothing here is published or stable yet.

## Licensing — read this first

This monorepo carries a deliberate license split:

| Part | License | File |
|---|---|---|
| Code (`packages/`, `apps/`, `examples/`) | Apache-2.0 | [`LICENSE-CODE`](./LICENSE-CODE) |
| Protocol spec (`spec/`) | CC-BY-4.0 | [`LICENSE-SPEC`](./LICENSE-SPEC) |

Apache-2.0 gives code adopters an explicit patent grant — relevant in the
payment/crypto space. CC-BY-4.0 lets anyone reproduce, translate, and build on the
spec with attribution, following current W3C/WHATWG practice. See [`NOTICE`](./NOTICE).

## Repository layout

```
spec/           Normative protocol spec (standards track, CC-BY-4.0)
packages/       Reference implementation, published as @chainvue/v402-* (Apache-2.0)
apps/           Public integration examples (demo-server) — not published
examples/       Snippet-only examples
docs/           Integration guides
docker/         Dockerfiles + compose deployment
```

The spec is the standard; the packages are one implementation of it. Anyone can
implement v402 in any language against `spec/` and the reference test vectors.

## Quickstart (dev)

Requires Node >= 22 and pnpm >= 9.

```bash
pnpm install
pnpm test        # vitest workspace mode
pnpm typecheck
```

Copy `.env.example` to `.env` and fill in your values — see the comments in that file.
Real secrets never enter the repo.

Package code lands layer by layer per the delivery plan (`PLAN.md`); until Layer 1+
ships, `packages/` and `apps/` are intentionally empty.

## Spec

Start at [`spec/README.md`](./spec/README.md). Current version: **v402/0.1 (draft)**.
Governance (BDFL model during v0.x, transition plan to a TSC) is documented in
[`spec/governance.md`](./spec/governance.md).

## Governance & stewardship

The v402 spec is stewarded by chainvue (Robert Lech) during v0.x. The spec is
CC-BY-4.0 and the code Apache-2.0 — permanently forkable, no vendor lock-in.
