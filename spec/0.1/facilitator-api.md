# Facilitator HTTP API — v402/0.1

**Status:** DRAFT — placeholder skeleton. Normative content lands in Etappe 1,
Layer 7 (delivery plan step 24), generated alongside the reference facilitator.
Until this banner is removed, `PLAN.md` at the repo root is the working source
of truth.

Normative HTTP API of the facilitator — the payment infrastructure service
between customer and API operator (signature verify, balance state, deposit
watching, blocklist). Any implementer (Rust, Go, Python, …) builds a compatible
middleware or facilitator against this document.

## Planned sections

1. **Deployment modes** — in-process vs. HTTP; identical interface, config-only
   switch
2. **Endpoints**
   - `POST /v1/verify` — stateless signature verification
   - `POST /v1/reserve` — verify + reserve (two-phase debit, phase 1)
   - `POST /v1/commit` / `POST /v1/rollback` — phase 2, strictly conditional
   - `GET /v1/identity/:id`
   - `GET /v1/balance` — signed-request auth (`v402-balance-query` payload)
   - `GET /v1/topup-instructions` — public, no auth
   - `GET /v1/health`
   - `GET /.well-known/v402` — discovery
3. **Request/response shapes** — with examples; OpenAPI generated from the
   reference TypeScript types
4. **Authorization** — HTTP-Basic per-middleware tokens in v0.1
5. **Idempotency** — `reserve`/`commit`/`rollback` idempotent per requestId
6. **Rate limits** — per-token limits, 429 + `Retry-After`
7. **Error codes catalog**
