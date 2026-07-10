# @chainvue/v402-nestjs

NestJS adapter for [v402](https://github.com/chainvue/v402): charge per request
on any route with a decorator.

- `@V402Payment({ amount, ... })` — route decorator declaring the price (and
  optional bodyHash policy)
- `PaymentGuard` — runs the verify + reserve phase before the handler
- `PaymentInterceptor` — commits after the response (two-phase debit: commit on
  2xx–4xx, rollback on ≥ 500 — a definitive answer is a rendered service)
- `V402Module` — wires either **in-process** verification (own storage + Verus
  RPC) or **http mode** against a standalone facilitator daemon

```sh
npm install @chainvue/v402-nestjs
```

Integration walkthrough, mode comparison, and configuration reference:
[docs/integration](https://github.com/chainvue/v402/tree/main/docs/integration)
in the repo.

Requirements worth knowing up front: bodyHash policies need the app created
with `{ rawBody: true }` (the guard fails closed with an operator error
otherwise), and path matching uses the request target verbatim — path-rewriting
proxies in front of the API are unsupported, as the spec states.

## License

Apache-2.0
