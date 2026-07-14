# @chainvue/v402-nestjs

NestJS adapter for [v402](https://github.com/chainvue/v402): charge per request on any route with one decorator.

```sh
npm install @chainvue/v402-nestjs
```

```ts
import { V402Payment } from "@chainvue/v402-nestjs";

@Get("report")
@V402Payment({ amount: "0.002" }) // human decimal string; bigint sats under the hood
getReport() {
  // handler only runs after payment is verified + reserved
}
```

## What it does

- `@V402Payment({ amount, ... })` — declares a route's price (and optional bodyHash policy)
- `PaymentGuard` — verify + reserve before the handler
- `PaymentInterceptor` — two-phase commit after the response (commit on 2xx–4xx, rollback on ≥ 500)
- `V402Module` — wires **in-process** verification (own storage + Verus RPC) or **http mode** against a standalone facilitator daemon

## Good to know

- bodyHash policies need the app created with `{ rawBody: true }` — the guard fails closed otherwise.
- Path matching uses the request target verbatim; path-rewriting proxies in front of the API are unsupported.
- Integration walkthrough, mode comparison, config reference: [docs/integration](https://github.com/chainvue/v402/tree/main/docs/integration).

## License

Apache-2.0
