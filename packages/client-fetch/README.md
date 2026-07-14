# @chainvue/v402-client-fetch

[v402](https://github.com/chainvue/v402) client for AI agents and services. `wrapFetchWithPayment` returns a drop-in `fetch` that handles the 402 handshake transparently — select an accepted scheme, sign the canonical payload, retry with `X-V402-*` headers, recover from price changes. `V402Client` covers the rest of the facilitator API.

```sh
npm install @chainvue/v402-client-fetch
```

```ts
import { wrapFetchWithPayment } from "@chainvue/v402-client-fetch";
import { EnvSigner } from "@chainvue/v402-signer-verus";

const paidFetch = wrapFetchWithPayment(fetch, {
  payer: "v402-agent@",
  signer: new EnvSigner(),
});
const res = await paidFetch("https://api.example.com/paid/thing");
```

## What it does

- `wrapFetchWithPayment(fetch, config)` — transparent 402 pay-and-retry, drop-in `fetch`
- `V402Client` — signed balance queries, topup info, discovery
- `ulid()` — parallel-safe request IDs; `AcceptsCache` — cache 402 challenges

## Good to know

- Retry follows the normative M5 table: same-`requestId` auto-retry only for network failures / 503 / 429. Endpoint 5xx is **not** auto-retried (the reservation was rolled back server-side; repeating a possibly side-effectful request is the caller's decision, with a fresh ULID).
- Node ≥ 22. Browser support is on the roadmap.

## License

Apache-2.0
