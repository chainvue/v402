# @chainvue/v402-mcp

MCP server for [v402](https://github.com/chainvue/v402): lets Claude (or any MCP host) **pay for APIs mid-conversation** from a prepaid VerusID balance — with hard, operator-controlled spending limits.

## Setup (Claude Desktop / Claude Code)

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

Then ask Claude *"check my v402 balance"* or *"fetch https://api.example.com/report and summarize it"* — signing and the two-phase payment happen transparently, and every paid call reports its price and the session total back into the conversation.

## Tools

| Tool | What it does |
|---|---|
| `v402_paid_fetch` | fetch a URL; on 402, pay and retry within the caps |
| `v402_balance` | signature-authenticated balance / reserved / available |
| `v402_topup_instructions` | how to fund the identity (text, URI, QR) |
| `v402_discover` | a service's `/.well-known/v402` incl. the endpoint rate card |

## Spending caps

Guardrails live on the agent boundary, not the model's goodwill:

- `V402_MCP_MAX_PER_REQUEST` — reject any single price above this (checked against the 402 challenge **before** signing).
- `V402_MCP_MAX_TOTAL` — cumulative cap per server process.
- `V402_MCP_ALLOWED_HOSTS` — hosts the agent may call at all.

## Good to know

- `V402_MCP_IDENTITY_ADDRESS` + `V402_MCP_SYSTEM_ID` switch the signer to identity-mode — **required against a real chain** (address-mode signatures do not verify for `…@` payers). Resolve both once via `getidentity myagent@`; block heights come from the facilitator's health endpoint automatically.
- Keys never leave the MCP process; prices are verified server-side against the signed canonical payload; every request is replay-protected.
- Try it on VRSCTEST: run the demo stack (`docker compose up` in the [v402 repo](https://github.com/chainvue/v402)), fund an agent identity ([discovery-topup](https://github.com/chainvue/v402/blob/main/docs/integration/discovery-topup.md)), then wire the config above.

## License

Apache-2.0
