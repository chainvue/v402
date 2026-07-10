# v402 Scheme Registry

Payment schemes plug into the v402 envelope via a namespaced registry. Even
though v0.1 ships one implemented scheme (`verus-prepaid-sig`), the protocol is
multi-scheme by design: adding a scheme is a registration, not a refactor.

## Naming convention

Format: `<network-family>-<mechanism>`, or `x-<vendor>-<mechanism>` for
vendor-custom schemes.

**Reserved network-family prefixes** (require registration via PR to
[`registered/`](./registered/)):

| Prefix | Family | Steward |
|---|---|---|
| `verus-*` | Verus-native | chainvue (during v0.x) |
| `evm-*` | EVM chains (aligned with Coinbase x402 where possible) | — |
| `solana-*` | Solana | — |
| `bitcoin-*` | Bitcoin / Lightning | — |
| `starknet-*`, `cosmos-*`, `polkadot-*` | reserved for future | — |

Other network-family prefixes: coordinate via PR to this spec repo.

**Vendor-custom prefix** — `x-<vendor>-<mechanism>`: no registration required,
use anything you want (analogous to the deprecated HTTP `X-` header
convention). A vendor scheme that gains traction can graduate to
`registered/` via PR.

## Directory layout

```
registered/     community-recognized schemes (one .md per scheme)
experimental/   x-<vendor>-* schemes that gained traction
deprecated/     historical schemes + deprecation reasons
```

Each registered scheme's `.md` file contains: normative spec extensions over
the base protocol, wire-format additions, test-vector references,
reference-implementation links, steward, version history.

## Registration process

1. PR adding `registered/<name>.md`
2. Steward review (BDFL during v0.x): naming convention, no conflict,
   technical merit, reference implementation exists
3. Merge = recognized

## Registered schemes

| Scheme | Version | Status | Steward |
|---|---|---|---|
| [`verus-prepaid-sig`](./registered/verus-prepaid-sig.md) | 0.1 | draft | chainvue |
