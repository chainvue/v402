# Canonical Payload & Wire Format — v402/0.1

**Status:** DRAFT — placeholder skeleton. Normative content lands in Etappe 1,
Layer 1 (`packages/protocol` + test vectors freeze the byte format). Until this
banner is removed, `PLAN.md` at the repo root is the working source of truth.

Defines the exact byte string a client signs and a server rebuilds. Any
deviation of a single byte is a verification failure — this document is the
byte-level contract between independent implementations.

## Planned sections

1. **Canonical string layout** — line 1 `<scheme>/<schemeVersion>`, then the
   11 core fields in fixed order (`canonicalDomain`, `method`, `path`,
   `scheme`, `network`, `asset`, `amount`, `payer`, `payTo`, `requestId`,
   `issuedAt`)
2. **Byte-level rules** — LF-only separators, exact `key: value` colon-space,
   no trailing newline, no whitespace variance
3. **Field serialization** — `issuedAt` as integer Unix seconds, `requestId`
   as ULID (Crockford base32, 26 chars), decimal serialization rules for
   `amount` (no leading zeros, `.` separator)
4. **`path` verbatim rule** — request-target byte-exact incl. query string,
   no normalization on either side, client duties (build URL once, no
   dot-segments), path-rewriting proxies unsupported
5. **Extension section** — placement after `issuedAt`, alphabetical sort,
   prefix grammar, byte-identical wire transport via `X-V402-Extensions`
6. **Server-side rebuild rule** — core values from server truth; only `path`,
   `payer`, `requestId`, `issuedAt` originate from the request and are
   validated
7. **Domain-separated payloads** — `v402-balance-query/0.1` canonical form
8. **Reference test vectors** — [`test-vectors/`](./test-vectors/)
   `canonical.json` as the conformance gate
