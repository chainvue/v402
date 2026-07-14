# v402 — Verus-native pay-per-request for AI-agent APIs

Charge AI agents **per request**; let agents **pay autonomously** — in
Verus-native currencies. Same HTTP-402 handshake as Coinbase's x402, but the
payment layer is Verus: **VerusID** identity, **off-chain signatures** for
zero-latency auth, and a **prepaid balance** for near-zero per-request cost. No
gas per call, no API keys, no card on file — one signature per request, settled
against an on-chain-funded balance.

**Beta on testnet.** Spec **v402/0.1** is normative and frozen; all 14 reference
packages are on npm (OIDC trusted publishing, SLSA provenance); the stack is
verified end-to-end against VRSCTEST including real on-chain deposits. Mainnet
is a config change away — not yet blessed for production.

## 60-second demo: Claude pays for an API

Add [`@chainvue/v402-mcp`](./packages/mcp) to Claude Desktop or Claude Code:

```json
{ "mcpServers": { "v402": {
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
} } }
```

Ask Claude to fetch a priced endpoint — it discovers prices, pays within your
caps, and refuses the rest. Limits are checked against the 402 challenge
**before** anything is signed:

```
paid_fetch /api/status → 200 | paid 0.0001 VRSCTEST | sessionSpent 0.0001
cap check /api/report (0.01 > cap 0.005): REFUSED
```

## Pick your path

**Charge for your API** — a NestJS decorator:

```ts
@Get("api/report") @V402Payment("0.01")
report() { … }
```

…or drop the [reverse proxy](./packages/proxy) in front of any existing origin
(any language, no code changes): a rules file prices your routes,
`docker compose -f docker-compose.proxy.yml up` does the rest.

**Pay as a client** — [`@chainvue/v402-client-fetch`](./packages/client-fetch):

```ts
const paidFetch = wrapFetchWithPayment(fetch, { payer: "myagent@", signer });
await paidFetch("https://api.example.com/api/report"); // 402 handled transparently
```

Parallel-safe, self-healing on price changes. Or use the MCP server above — no code.

**Implement the standard** — [`spec/0.1/`](./spec/0.1/) is normative (CC-BY-4.0,
RFC 2119). Prove any implementation, in any language, against the vectors:

```sh
npx v402-conformance --strict -- ./my-implementation
```

Start with the [implementer guide](./docs/integration/implementers.md); the
facilitator contract is machine-readable as
[OpenAPI 3.1](./spec/0.1/facilitator-api.openapi.yaml).

## Packages

All published as `@chainvue/*` under Apache-2.0.

| Package | What it is |
|---|---|
| [`v402-protocol`](./packages/protocol) | canonical payload, headers, wire schemas — dependency-light core |
| [`v402-signer-verus`](./packages/signer-verus) | Verus crypto: address + VerusID (N-of-M) signing and offline verify |
| [`v402-verifier`](./packages/verifier) | scheme verifier (RPC or offline mode), facilitator HTTP client |
| [`v402-verus-rpc`](./packages/verus-rpc) | minimal, v402-scoped Verus JSON-RPC client |
| [`v402-storage`](./packages/storage) / [`-sqlite`](./packages/storage-sqlite) | balance/ledger interface + SQLite implementation |
| [`v402-deposit-watcher`](./packages/deposit-watcher) | on-chain deposit detection, reorg handling, attribution |
| [`v402-facilitator`](./packages/facilitator) | standalone payment daemon: verify/reserve/commit/rollback API |
| [`v402-nestjs`](./packages/adapter-nestjs) | NestJS guard + interceptor + discovery controller |
| [`v402-proxy`](./packages/proxy) | reverse proxy: payment guard in front of any origin |
| [`v402-client-fetch`](./packages/client-fetch) | paying `fetch` wrapper + full client (balance, topup, discovery) |
| [`v402-mcp`](./packages/mcp) | MCP server: agents pay mid-conversation, with spending caps |
| [`v402-test-vectors`](./packages/test-vectors) | the normative vectors as an npm package |
| [`v402-conformance-suite`](./packages/conformance-suite) | conformance runner + cross-language CLI |

## Develop

Node ≥ 22, pnpm ≥ 10.

```bash
pnpm install
pnpm build && pnpm typecheck && pnpm lint && pnpm test
```

`docker-compose.yml` boots the facilitator + demo-server pair; the contributor
path uses simulated deposits and needs no Verus node. Node-gated integration
tests skip cleanly without `VERUS_RPC_URL`. Integration guides:
[`docs/integration/`](./docs/integration/); decisions and risks:
[`docs/RISKS.md`](./docs/RISKS.md).

## Licensing

Code (`packages/`, `apps/`) is **Apache-2.0**
([`LICENSE-CODE`](./LICENSE-CODE)) — an explicit patent grant, relevant in the
payments/crypto space. The protocol spec (`spec/`) is **CC-BY-4.0**
([`LICENSE-SPEC`](./LICENSE-SPEC)) — reproduce, translate, and build on it with
attribution. Permanently forkable, no vendor lock-in. Stewarded by chainvue
(Robert Lech) during v0.x; see [`spec/governance.md`](./spec/governance.md) and
[`NOTICE`](./NOTICE).
