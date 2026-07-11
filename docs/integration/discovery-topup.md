# Discovery + topup UX for new customers

How a fresh agent goes from zero to paid requests.

## 1. Discover the service

```ts
const client = new V402Client({
  identity: "v402.myAgent@",
  signer,
  facilitator: "https://facilitator.example.com",
});
const discovery = await client.discover();          // facilitator .well-known/v402
const api = await client.discover("https://api.example.com"); // any v402 API
```

`GET /.well-known/v402` (RFC 8615) advertises versions, supported extensions,
schemes with `payTo`, and the topup endpoint. Per-route prices arrive in the
402 challenge itself — clients need no rate card up front.

**Trust model:** discovery and 402 responses are unauthenticated. Use HTTPS,
pin `payTo` for services you use regularly (warn/abort when it changes), and
verify the deposit address out-of-band the first time.

## 2. Get topup instructions

```ts
const topup = await client.getTopupInstructions({ amount: "5" });
// topup.instructions.text        "Send 5 VRSCTEST from v402.myAgent@ to myAPI@"
// topup.instructions.paymentUri  verus://send?to=…&currency=…&amount=5&from=…
// topup.instructions.qrCode      data:image/png;base64,…  (render for humans)
```

Public endpoint, no auth — it reveals only a URI template. Deposits are
attributed by **sender identity**: the transaction's inputs must come from
your VerusID (all identity inputs must resolve to the same identity —
mixed-identity or t-address-only funding lands in manual reconciliation and
is NOT auto-credited). Shielded funding cannot be attributed.

## 3. Wait for the credit

Deposits credit after the confirmation depth (default 10 blocks ≈ 10 min):

```ts
for (;;) {
  const balance = await client.getBalance(); // signed query — only you can read it
  if (BigInt(balance.availableSats) >= needed) break;
  await sleep(30_000);
}
```

`getBalance()` signs a domain-separated `v402-balance-query` payload (a
payment signature can never double as a balance query, and vice versa) and is
replay-protected like payments.

## 4. Pay

```ts
const res = await client.fetch("https://api.example.com/api/tx/abc");
```

First request without payment → 402 with `accepts` → the client signs and
resends transparently. Fully parallel-safe (`Promise.all` with hundreds of
requests is fine — each rolls its own ULID).

Repeat calls to the same endpoint skip the 402 preflight — the challenge is
cached per `METHOD origin/path` (TTL 5 min). Staleness is self-healing: any
402 on a cached attempt (price or payTo changed) re-signs from that
response's fresh `accepts`, so the worst case is one extra roundtrip and the
debit is always the CURRENT advertised price. `acceptsCache: false` opts out.

**Credits are non-refundable** (plan Q8) — top up in amounts you intend to
spend. Failed requests (5xx) are automatically refunded to your balance;
definitive answers (2xx and 4xx) are charged.
