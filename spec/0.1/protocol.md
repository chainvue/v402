# v402 Core Protocol — v402/0.1

**Status:** DRAFT — placeholder skeleton. Normative content lands in Etappe 1
(Layers 1+) as the reference implementation freezes the wire format. Until this
banner is removed, `PLAN.md` at the repo root is the working source of truth.

Governs the protocol **envelope**: everything scheme-independent. Individual
payment schemes (e.g. [`prepaid-sig-scheme.md`](./prepaid-sig-scheme.md)) build
on top of this document.

## Planned sections

1. **Terminology & conformance language** (RFC 2119/8174 keywords)
2. **Discovery** — `GET /.well-known/v402`: `specUrl`, `supportedVersions`,
   `defaultVersion`, `deprecatedVersions`, `sunsetDates`, `supportedExtensions`
3. **402 response** — `accepts` array (multi-entry from day 1), field semantics
   (`scheme`, `schemeVersion`, `network`, `asset`, `amount`/`amountUnit`,
   `payTo`, `facilitator`, `requiredHeaders`, `canonicalDomain`, `topup`)
4. **Request headers** — `X-V402-Scheme`, `X-V402-Payer`, `X-V402-Amount`,
   `X-V402-Request-Id`, `X-V402-Issued-At`, `X-V402-Signature`,
   `X-V402-Extensions`
5. **Version negotiation** — protocol version vs. scheme version (two
   namespaces), negotiation rules, semver for the wire format, deprecation
   signaling; distinct errors `unsupported-version` / `unsupported-scheme-version`
6. **Extension mechanics** — prefix rules (`scheme.*`, `x-<vendor>.*`,
   `iana.*`), alphabetical sort, single-header wire transmission
   (base64, 4 KB decoded limit), unknown-extension handling
   (strict-reject / accept-ignore matrix)
7. **Scheme namespace registry** — reserved network-family prefixes,
   vendor-custom `x-*`, registration process (see [`../schemes/`](../schemes/))
8. **Error catalog** — status codes + machine-readable error identifiers
   (`price-mismatch`, `no-balance`, `extensions-too-large`, …)
9. **Trust model & transport security** — discovery/402 are unauthenticated;
   HTTPS REQUIRED in production; `payTo` pinning guidance
