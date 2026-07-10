# Signer options: Node vs Env vs File

`@chainvue/v402-signer-verus` ships three `Signer` implementations. The
client library never touches raw keys — community signers (Ledger, Keychain,
…) implement the same one-method interface.

## Decision table

| Deployment | Signer | Key location |
|---|---|---|
| Server with a Verus daemon | **NodeSigner** (recommended) | stays in the wallet |
| Headless / container / CI without a node | **EnvSigner** | env var via secret manager |
| Local dev, multiple identities | **FileSigner** | `~/.v402/keys/<identity>.key`, mode 0600 |

## NodeSigner

```ts
import { NodeSigner } from "@chainvue/v402-signer-verus";

const signer = new NodeSigner({
  signer: "v402.demoAgent@",             // wallet identity (or R-address)
  rpc: { rpcUrl: "http://127.0.0.1:18843", rpcUser: "…", rpcPass: "…" },
});
```

The private key never enters your process; rotation is standard VerusID key
rotation. Identity signatures come out in the daemon's native format.

## EnvSigner / FileSigner (local WIF signing)

```ts
import { EnvSigner, FileSigner } from "@chainvue/v402-signer-verus";
import { facilitatorHeightProvider } from "@chainvue/v402-client-fetch";

// address-mode: signs as the key's R-address
const addressSigner = new EnvSigner();                       // reads VERUS_SIGNING_KEY
const devSigner = new FileSigner({ path: "~/.v402/keys/agent.key" }); // must be chmod 600

// identity-mode: sign AS a VerusID (what v402 payers need).
// Identity signatures embed a recent block height — the height provider
// reads it from the facilitator's public health endpoint, no node needed.
const signer = new EnvSigner({
  identity: "v402.demoAgent@",
  heightProvider: facilitatorHeightProvider("https://facilitator.example.com"),
});
```

Rules baked in (fail closed):

- FileSigner refuses group/world-readable key files (chmod 600).
- EnvSigner throws when the variable is unset; never log its value — use a
  secret manager in production.
- Identity mode without a heightProvider throws: `verifymessage <identity>`
  does NOT accept bare address signatures, and the identity format embeds the
  signing height (primary keys are resolved at that height).
- Local signing is byte-compatible with the daemon's verification (validated
  against the reference test vectors and live `verifymessage`); the exact
  signature bytes differ from daemon-produced ones — that is expected and
  irrelevant (recovery-based verification).

## Wiring into the client

```ts
import { wrapFetchWithPayment } from "@chainvue/v402-client-fetch";

const paidFetch = wrapFetchWithPayment(fetch, { payer: "v402.demoAgent@", signer });
const res = await paidFetch("https://api.example.com/api/tx/abc");
```

Client retry behavior (normative M5 table): network failures, 503 and 429 are
retried automatically with the SAME requestId (idempotent reserve — no
double-pay risk); `price-mismatch` re-signs with a fresh ULID at the new
price. Endpoint 5xx is NOT auto-retried — the payment was already rolled
back server-side, and whether to repeat a possibly side-effectful call is
your business decision; if you retry, the library rolls a fresh ULID anyway.
