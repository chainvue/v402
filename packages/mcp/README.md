# @chainvue/v402-mcp

MCP server for [v402](https://github.com/chainvue/v402): gives Claude (or
any MCP host) the ability to **pay for APIs mid-conversation** from a
prepaid VerusID balance — with hard, operator-controlled spending limits.

| Tool | What it does |
|---|---|
| `v402_paid_fetch` | fetch a URL; if it answers 402, pay and retry — within the caps |
| `v402_balance` | signature-authenticated balance/reserved/available |
| `v402_topup_instructions` | how to fund the identity (text, URI, QR) |
| `v402_discover` | a service's `/.well-known/v402` incl. the endpoint rate card |

## Spending protection

Guardrails live on the agent boundary, not in the model's goodwill:

- `V402_MCP_MAX_PER_REQUEST` — refuse any single price above this (checked
  against the 402 challenge **before** signing anything).
- `V402_MCP_MAX_TOTAL` — cumulative cap per server process.
- `V402_MCP_ALLOWED_HOSTS` — comma list of hosts the agent may call at all.

## Claude Desktop / Claude Code setup

```json
{
  "mcpServers": {
    "v402": {
      "command": "npx",
      "args": ["-y", "@chainvue/v402-mcp"],
      "env": {
        "V402_MCP_FACILITATOR": "https://facilitator.example.com",
        "V402_MCP_IDENTITY": "myagent@",
        "VERUS_SIGNING_KEY": "<WIF of a primary key of myagent@>",
        "V402_MCP_IDENTITY_ADDRESS": "<i-address of myagent@>",
        "V402_MCP_SYSTEM_ID": "<chain i-address, e.g. iJhCez… for VRSCTEST>",
        "V402_MCP_MAX_PER_REQUEST": "0.01",
        "V402_MCP_MAX_TOTAL": "1",
        "V402_MCP_ALLOWED_HOSTS": "api.example.com"
      }
    }
  }
}
```

`V402_MCP_IDENTITY_ADDRESS` + `V402_MCP_SYSTEM_ID` switch the signer to
identity-mode signatures — **required against a real chain** (address-mode
signatures do not verify for `…@` payers). Resolve both once via
`getidentity myagent@` (`identityaddress`, `systemid`); block heights come
from the facilitator's health endpoint automatically.

Then ask Claude things like *"check my v402 balance"* or *"fetch
https://api.example.com/api/report and summarize it"* — the 402 handshake,
signing and two-phase payment happen transparently, and every paid call
reports the price and the session total back into the conversation.

## Trying it on VRSCTEST

1. Run the demo stack: `docker compose up` in the
   [v402 repo](https://github.com/chainvue/v402) (facilitator + priced demo
   API), or point at any deployed v402 service.
2. Register/fund an agent identity (see
   [`docs/integration/discovery-topup.md`](https://github.com/chainvue/v402/blob/main/docs/integration/discovery-topup.md)).
3. Wire the MCP config above at the facilitator/demo URLs.

The security model in one line: the model decides *what* to fetch, the
operator decides *how much it may ever spend* — keys never leave the MCP
process, prices are verified against the signed canonical payload
server-side, and every request is replay-protected.

## License

Apache-2.0
