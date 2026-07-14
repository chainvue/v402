# @chainvue/v402-signer-verus

Signer implementations for [v402](https://github.com/chainvue/v402) clients: local WIF signing (`EnvSigner`, `FileSigner`) and Verus-daemon signing (`NodeSigner`). Supports both address and **VerusID identity** signatures — byte-compatible with verusd and validated against the reference test vectors.

```sh
npm install @chainvue/v402-signer-verus
```

```ts
import { EnvSigner } from "@chainvue/v402-signer-verus";

// WIF from $VERUS_SIGNING_KEY; pass { identity, heightProvider } for VerusID signing
const signer = new EnvSigner();
const signature = await signer.signMessage(canonicalString);
```

## Signers

- `EnvSigner` — WIF from an env var (12-factor / secret-manager friendly)
- `FileSigner` — WIF from a key file; refuses group/world-accessible files (mode must be `0600`)
- `NodeSigner` — delegates to a Verus daemon's `signmessage` (wallet holds the key)

All implement `Signer.signMessage(message): Promise<string>` — Base64 that `verifymessage` accepts.

## Good to know

- Identity-mode signing needs the identity's i-address, the chain i-address, and a `heightProvider` (the digest binds chain, height, and identity — resolve the addresses once via `getidentity`). Without `identity`, signatures verify against the R-address only, not a `…@` name.
- Local signatures are deterministic (RFC 6979) but not byte-equal to verusd's non-standard nonce variant; verification is recovery-based, so validity is unaffected.

## License

Apache-2.0
