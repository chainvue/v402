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
- [Building a v402 implementation (any language)](./implementers.md) — map of
  the normative sources, the crypto pitfalls, test vectors, and the
  `v402-conformance` CLI as acceptance gate

Protocol-level reference: [`spec/`](../../spec/) (normative), including the
[facilitator HTTP API](../../spec/0.1/facilitator-api.md) — machine-readable
as [OpenAPI 3.1](../../spec/0.1/facilitator-api.openapi.yaml) — for non-JS
implementations.
