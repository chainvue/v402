# Scheme: `verus-prepaid-sig` — version 0.1

**Status:** DRAFT — placeholder skeleton. Normative content lands in Etappe 1
(Layers 1+). Until this banner is removed, `PLAN.md` at the repo root is the
working source of truth.

Verus-native prepaid payment scheme: VerusID identities, off-chain
`signmessage`/`verifymessage` signatures, prepaid balance funded by on-chain
deposits with sender-VerusID attribution.

Registry entry: [`../schemes/registered/verus-prepaid-sig.md`](../schemes/registered/verus-prepaid-sig.md)

## Planned sections

1. **Scheme identifier & versioning** — `verus-prepaid-sig/0.1` as payload
   line 1; independent of the protocol version
2. **Identity model** — VerusID payers, `v402.*@` sub-ID namespace, open
   registration
3. **Signature scheme** — canonical payload (normative rules in
   [`canonical-payload.md`](./canonical-payload.md)), Verus `signmessage`
   semantics, standard Base64 pass-through encoding
4. **Replay protection** — unique request-id (ULID) + time window
   (`|now − issuedAt| ≤ 300 s`), burned-id semantics on error
5. **Balance model** — prepaid, two-phase debit (reserve → commit/rollback),
   insufficient-balance behavior, no refunds in v0.1
6. **Deposits** — sender-VerusID attribution, multi-vin rule, confirmation
   depth, reorg + re-mine handling
7. **Client retry policy (normative)** — "no definitive answer → same
   requestId; definitive error → fresh ULID" table
8. **Extensions** — `scheme.bodyHash` (sha256 over raw body, per-endpoint
   `required | optional | ignored` policy)
9. **Error semantics** — scheme-specific errors and status mapping
10. **Test vectors** — references into [`test-vectors/`](./test-vectors/)
