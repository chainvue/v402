# v402 — Verus-Native Payment Layer for AI-Agent APIs

v402 lets APIs charge AI agents **per request** — and lets agents **pay
autonomously** — using Verus-native currencies. It borrows the HTTP-402
handshake pattern from Coinbase's x402 spec but replaces the EVM payment
layer with a Verus-native scheme (`verus-prepaid-sig`): **VerusID** for
identity, **off-chain signatures** for zero-latency authentication, and a
**prepaid balance** model for near-zero per-request cost. No gas per call,
no API keys, no card on file — a signature per request, settled against an
on-chain-funded balance.

**Status: beta on testnet.** Spec **v402/0.1** is normative and frozen; all
14 reference packages are on npm (published via OIDC trusted publishing with
SLSA provenance); the full stack is verified end-to-end against VRSCTEST
including real on-chain deposits. Mainnet deployment is a configuration
change away, but the steward has not blessed a production deployment yet.

## The 60-second demo: Claude pays for an API

Add [`@chainvue/v402-mcp`](./packages/mcp) to Claude Desktop or Claude Code:

```json
{
  "mcpServers": {
    "v402": {
      "command": "npx",
      "args": ["-y", "@chainvue/v402-mcp"],
      "env": {
        "V402_MCP_FACILITATOR": "https://facilitator.example.com",
        "V402_MCP_IDENTITY": "myagent@",
        "VERUS_SIGNING_KEY": "<WIF>",
        "V402_MCP_IDENTITY_ADDRESS": "<i-address>",
        "V402_MCP_SYSTEM_ID": "<chain i-address>",
        "V402_MCP_MAX_PER_REQUEST": "0.01",
        "V402_MCP_MAX_TOTAL": "1"
      }
    }
  }
}
```

Then ask Claude to fetch a priced endpoint. From the live run against
VRSCTEST — the model discovers prices, pays within operator-set caps, and
refuses everything else:

```
rate card: /api/graphql=0.002 /api/report=0.01 /api/status=0.0001
paid_fetch /api/status → 200 | paid 0.0001 VRSCTEST | sessionSpent 0.0001
cap check /api/report (0.01 > cap 0.005): REFUSED
allowlist check example.com: REFUSED
```

Spending limits are enforced on the agent boundary — checked against the 402
challenge **before** anything is signed. The model decides *what* to fetch;
the operator decides *how much it may ever spend*.

## Pick your path

**Charge for your API** — two integrations:

```ts
// NestJS: one module import, then price routes with a decorator
@Get("api/report")
@V402Payment("0.01")
report() { … }
```

…or put the [reverse proxy](./packages/proxy) in front of **any** existing
origin (static site, WordPress, an API in any language) without touching it:
a rules file prices your routes, `docker compose -f docker-compose.proxy.yml
up` does the rest. Self-hosted pay-per-crawl, no origin changes.

**Pay as an agent / client** — [`@chainvue/v402-client-fetch`](./packages/client-fetch):

```ts
const paidFetch = wrapFetchWithPayment(fetch, { payer: "myagent@", signer });
const res = await paidFetch("https://api.example.com/api/report"); // 402 handled transparently
```

Parallel-safe, self-healing on price changes, with per-endpoint challenge
caching. Or skip code entirely and use the MCP server above.

**Implement the standard** — v402 is a spec first:
[`spec/0.1/`](./spec/0.1/) is normative (CC-BY-4.0, RFC 2119), conformance
is defined by [reference test vectors](./spec/0.1/test-vectors/), and any
implementation in any language can prove itself with the conformance CLI
over a stdin/stdout JSON protocol:

```sh
npx v402-conformance --strict -- ./my-implementation
```

Start with the [implementer guide](./docs/integration/implementers.md); the
facilitator HTTP contract is also machine-readable as
[OpenAPI 3.1](./spec/0.1/facilitator-api.openapi.yaml), validated against
the reference implementation on every CI run.

## Packages

| Package | What it is |
|---|---|
| [`@chainvue/v402-protocol`](./packages/protocol) | canonical payload, headers, wire schemas — dependency-light core |
| [`@chainvue/v402-signer-verus`](./packages/signer-verus) | Verus crypto: address + VerusID (N-of-M) signing and offline verification |
| [`@chainvue/v402-verifier`](./packages/verifier) | scheme verifier (RPC or offline mode), facilitator HTTP client |
| [`@chainvue/v402-verus-rpc`](./packages/verus-rpc) | minimal, v402-scoped Verus JSON-RPC client |
| [`@chainvue/v402-storage`](./packages/storage) / [`-sqlite`](./packages/storage-sqlite) | balance/ledger interface + SQLite implementation |
| [`@chainvue/v402-deposit-watcher`](./packages/deposit-watcher) | on-chain deposit detection, reorg handling, attribution |
| [`@chainvue/v402-facilitator`](./packages/facilitator) | standalone payment daemon: verify/reserve/commit/rollback API |
| [`@chainvue/v402-nestjs`](./packages/adapter-nestjs) | NestJS adapter: guard + interceptor + discovery controller |
| [`@chainvue/v402-proxy`](./packages/proxy) | reverse proxy: payment guard in front of any origin |
| [`@chainvue/v402-client-fetch`](./packages/client-fetch) | paying fetch wrapper + full client (balance, topup, discovery) |
| [`@chainvue/v402-mcp`](./packages/mcp) | MCP server: agents pay mid-conversation, with spending caps |
| [`@chainvue/v402-test-vectors`](./packages/test-vectors) | the normative vectors as an npm package |
| [`@chainvue/v402-conformance-suite`](./packages/conformance-suite) | conformance runner + cross-language CLI |

## Licensing — read this first

This monorepo carries a deliberate license split:

| Part | License | File |
|---|---|---|
| Code (`packages/`, `apps/`, `examples/`) | Apache-2.0 | [`LICENSE-CODE`](./LICENSE-CODE) |
| Protocol spec (`spec/`) | CC-BY-4.0 | [`LICENSE-SPEC`](./LICENSE-SPEC) |

Apache-2.0 gives code adopters an explicit patent grant — relevant in the
payment/crypto space. CC-BY-4.0 lets anyone reproduce, translate, and build
on the spec with attribution, following current W3C/WHATWG practice. See
[`NOTICE`](./NOTICE).

## Repository layout

```
spec/           Normative protocol spec (standards track, CC-BY-4.0)
packages/       Reference implementation, published as @chainvue/v402-* (Apache-2.0)
apps/           Public integration examples (demo-server) — not published
examples/       Snippet-only examples
docs/           Integration guides + the honest risk/decision log (docs/RISKS.md)
docker/         Dockerfiles + compose deployments
```

The spec is the standard; the packages are one implementation of it.

## Quickstart (dev)

Requires Node >= 22 and pnpm >= 10.

```bash
pnpm install
pnpm build && pnpm typecheck && pnpm lint && pnpm test
```

Copy `.env.example` to `.env` and fill in your values — real secrets never
enter the repo. Integration tests that need a Verus node are gated behind
`VERUS_RPC_URL` and skip cleanly without one. The Docker stack
(`docker-compose.yml`) boots the facilitator + demo-server pair; the
contributor quickstart with simulated deposits needs no Verus node at all
(see the compose file header).

Integration guides live in [`docs/integration/`](./docs/integration/);
implementation decisions and risks are logged in [`docs/RISKS.md`](./docs/RISKS.md).

## Spec & governance

Start at [`spec/README.md`](./spec/README.md). Current version: **v402/0.1**
— normative, conformance defined by the test vectors. The spec is stewarded
by chainvue (Robert Lech) during v0.x (BDFL model, TSC transition plan in
[`spec/governance.md`](./spec/governance.md)). CC-BY-4.0 spec, Apache-2.0
code — permanently forkable, no vendor lock-in.
