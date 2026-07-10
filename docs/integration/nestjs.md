# Integrating v402 in a NestJS API

The whole integration is one module import plus one decorator per priced
route. Reference: [`apps/demo-server`](../../apps/demo-server/).

## 1. Install

```bash
pnpm add @chainvue/v402-nestjs
```

## 2. Create the app with raw-body capture

```ts
// main.ts — rawBody is REQUIRED if any route uses a bodyHash policy
const app = await NestFactory.create(AppModule, { rawBody: true });
```

Without it, the guard fails closed (HTTP 500 with an explanatory message) as
soon as a body-carrying request hits a `required`/`optional` bodyHash route —
it never silently skips verification.

## 3. Import the module

```ts
import { V402Module } from "@chainvue/v402-nestjs";

@Module({
  imports: [
    V402Module.forRoot({
      canonicalDomain: "api.example.com",   // domain signatures are bound to
      network: "vrsctest",
      asset: "VRSCTEST",
      payTo: "myAPI@",                      // receiving identity = deposit address
      facilitatorUrl: "https://facilitator.example.com", // advertised to clients

      // EITHER in-process (this app owns the SQLite + talks to the node):
      db: { path: "./data/v402.sqlite" },
      verus: { rpcUrl: "http://127.0.0.1:18843", rpcUser: "…", rpcPass: "…" },

      // OR http mode (a facilitator service owns the state):
      // mode: "http",
      // facilitatorInternalUrl: "http://facilitator:3000", // what THIS app calls
      // facilitatorAuthToken: process.env.FACILITATOR_AUTH_TOKEN!,
      // middlewareId: "my-api",
    }),
  ],
})
export class AppModule {}
```

`facilitatorUrl` vs `facilitatorInternalUrl`: the first is what **clients**
are told in 402 responses (public address); the second is what **this
middleware** calls (in-cluster address, e.g. the compose service name). They
differ in almost every real deployment.

Switching in-process ↔ http changes no other code — the verifier interface is
identical (plan § Facilitator API).

## 4. Price your routes

```ts
import { V402Payment } from "@chainvue/v402-nestjs";

@Get("api/tx/:txid")
@V402Payment("0.001")
transaction() { … }

// single-endpoint protocols (GraphQL/MCP/JSON-RPC): bind the payment to the body
@Post("api/graphql")
@V402Payment("0.002", { bodyHash: "required" })
graphql() { … }
```

Undecorated routes are untouched. The price string is advertised verbatim in
402 responses and compared **byte-wise** against `X-V402-Amount` (M6) — never
reformat it (`"0.001"` ≠ `"0.0010"`).

## 5. Two-phase semantics your handlers get for free

- Handler returns 2xx → the payment **commits**; the response carries
  `X-V402-Request-Id` (echo) and `X-V402-Balance` (payer's balance after).
- Handler throws **≥500** → the payment **rolls back** (client refunded);
  the requestId stays burned for the replay window.
- Handler throws **4xx** → the payment **commits**: a definitive answer
  (404, 422, …) is a rendered service — Stripe semantics. Design your error
  handling with that in mind.
- Commit failure after a successful handler (facilitator briefly down in
  http mode): the client gets a 500, the reservation expires via the reaper
  and refunds — the failure direction is always pro-customer.

## 6. Operational requirements

- **NTP-synced clocks** — the ±300 s `issuedAt` window assumes it.
- **HTTPS in production** — 402/discovery are unauthenticated; a MITM could
  otherwise swap `payTo` (spec trust model).
- **No path-rewriting proxies** in front of the API — the signature covers
  the request-target verbatim (M1).
- The per-IP throttle protects against unauthenticated floods only;
  distributed attacks need a WAF/CDN in front (plan risk table).
