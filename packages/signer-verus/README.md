# @chainvue/v402-signer-verus

Signer implementations for [v402](https://github.com/chainvue/v402) clients:

- `NodeSigner` — delegates to a Verus daemon's `signmessage` (wallet holds the key)
- `EnvSigner` / `FileSigner` — local WIF signing (@noble/curves), byte-compatible
  with verusd address signatures and validated against the reference test vectors;
  `FileSigner` enforces key-file mode `0600`

Both address signatures and **VerusID identity signatures** are supported. The
identity path implements the daemon's actual digest
(`verusIdentitySignDigest`: chain ID + block height + identity ID bound into
the signed hash — see
[`spec/0.1/prepaid-sig-scheme.md`](https://github.com/chainvue/v402/blob/main/spec/0.1/prepaid-sig-scheme.md))
and the `CIdentitySignature` envelope, verified live against verusd.

```sh
npm install @chainvue/v402-signer-verus
```

Notes: identity-mode local signing needs the identity's i-address and the chain
i-address (resolve once via `getidentity`). Local signatures are deterministic
(RFC 6979, `extraEntropy: false`) but not byte-equal to daemon signatures —
verusd uses a non-standard nonce variant; verification is recovery-based, so
this is irrelevant for validity.

## License

Apache-2.0
