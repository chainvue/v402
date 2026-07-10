# @chainvue/v402-verus-rpc

**Minimal, v402-scoped** Verus daemon JSON-RPC client: exactly the RPC methods
the [v402](https://github.com/chainvue/v402) payment stack needs
(`verifymessage` with `checklatest`, `signmessage`, `getidentity`, block/tx
lookups, `getcurrencybalance`, `sendcurrency`), wrapped in a 500 ms-timeout +
circuit-breaker policy (cockatiel). Includes `MockVerusRpc` for tests.

This is **deliberately not a general-purpose Verus client** and will stay
minimal — it exists so the payment path has a small, auditable RPC surface.

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

Failure semantics worth knowing: JSON-RPC application errors (e.g. a malformed
signature) do **not** count as circuit-breaker failures — only transport-level
failures trip the breaker, so signature spam cannot deny service.

## License

Apache-2.0
