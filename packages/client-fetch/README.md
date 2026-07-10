# @chainvue/v402-client-fetch

[v402](https://github.com/chainvue/v402) client for AI agents and services.
`wrapFetchWithPayment(fetch, config)` returns a drop-in `fetch` that handles
the 402 handshake transparently: on a 402 it selects an accepted scheme, signs
the canonical payload, retries with `X-V402-*` payment headers, and recovers
automatically from price changes (M6). `V402Client` covers the rest of the
facilitator API: signed balance queries, topup info, discovery.

```sh
npm install @chainvue/v402-client-fetch
```

```ts
import { wrapFetchWithPayment } from "@chainvue/v402-client-fetch";
import { EnvSigner } from "@chainvue/v402-signer-verus";

const paidFetch = wrapFetchWithPayment(fetch, {
  payer: "v402-agent@",
  signer: new EnvSigner(/* ... */),
});
const res = await paidFetch("https://api.example.com/paid/thing");
```

Retry semantics follow the normative M5 table: same-`requestId` auto-retry only
for network failures / 503 / 429; endpoint 5xx is **not** auto-retried (the
reservation was rolled back server-side — whether to repeat a possibly
side-effectful request is the caller's decision, with a fresh ULID). Node ≥ 22;
browser support is on the roadmap (Etappe 2).

## License

Apache-2.0
