# @chainvue/v402-verus-rpc

Minimal, v402-scoped Verus daemon JSON-RPC client — only the methods the [v402](https://github.com/chainvue/v402) payment stack needs, wrapped in a 500 ms-timeout + circuit-breaker policy (cockatiel). Ships `MockVerusRpc` for tests. Deliberately not a general-purpose Verus client.

```sh
npm install @chainvue/v402-verus-rpc
```

```ts
import { VerusRpcClient } from "@chainvue/v402-verus-rpc";

const rpc = new VerusRpcClient({
  rpcUrl: "http://127.0.0.1:18843",
  rpcUser: "...",
  rpcPass: "...",
});
const ok = await rpc.verifyMessage("v402test@", signature, message, true);
```

## What it does

- Covers exactly: `verifymessage` (with `checklatest`), `signmessage`, `getidentity`, block/tx lookups, `getcurrencybalance`, `sendcurrency`
- A small, auditable RPC surface for the payment path — nothing more
- `MockVerusRpc` for deterministic tests

## Good to know

- JSON-RPC application errors (e.g. a malformed signature) do **not** trip the circuit breaker — only transport failures do, so signature spam cannot deny service.

## License

Apache-2.0
