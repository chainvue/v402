# Integration Guides

- [Integrating v402 in a NestJS API](./nestjs.md) — one module import + one
  decorator per priced route; in-process vs http mode; two-phase semantics;
  operational requirements
- [Running the facilitator standalone (Docker)](./facilitator-docker.md) —
  compose quickstarts, environment reference, backups, secrets
- [Signer options: Node vs Env vs File](./signers.md) — decision table,
  identity-mode signing without a node, client retry behavior
- [Discovery + topup UX for new customers](./discovery-topup.md) — zero to
  paid requests: discover, top up, wait for credit, pay

Protocol-level reference: [`spec/`](../../spec/) (normative), including the
[facilitator HTTP API](../../spec/0.1/facilitator-api.md) for non-JS
implementations.
