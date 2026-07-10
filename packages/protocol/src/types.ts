/** One signed extension line, e.g. `{ key: "scheme.bodyHash", value: "sha256:…" }`. */
export interface ExtensionField {
  key: string;
  value: string;
}

/**
 * Input to `canonicalize()` — the 11 core fields plus optional extensions.
 * On the server, core values come from server truth (config + request); only
 * `path`, `payer`, `requestId`, `issuedAt` originate from the client.
 */
export interface CanonicalPayload {
  scheme: string;
  schemeVersion: string;
  canonicalDomain: string;
  method: string;
  /** Request-target verbatim as sent on the wire, incl. query string (M1). */
  path: string;
  network: string;
  asset: string;
  /** Human decimal string, e.g. "0.001" — signed byte-verbatim. */
  amount: string;
  payer: string;
  payTo: string;
  /** ULID, Crockford base32, 26 chars. */
  requestId: string;
  /** Unix seconds. */
  issuedAt: number;
  extensions?: ExtensionField[];
}

/** Input to `canonicalizeBalanceQuery()` — see spec § Topup Instructions Endpoint. */
export interface BalanceQueryPayload {
  canonicalDomain: string;
  network: string;
  payer: string;
  requestId: string;
  issuedAt: number;
}

/** One entry of the 402 response's `accepts` array. */
export interface PaymentRequirement {
  scheme: string;
  schemeVersion: string;
  network: string;
  asset: string;
  amount: string;
  amountUnit: "human";
  payTo: string;
  facilitator: string;
  requiredHeaders: string[];
  canonicalDomain: string;
  topup?: {
    depositAddress: string;
    attribution: "sender-verusid";
  };
}

/** The 402 Payment Required response body. */
export interface Payment402Response {
  version: string;
  accepts: PaymentRequirement[];
}

/** Parsed + validated `X-V402-*` request headers. */
export interface PaymentClaim {
  scheme: string;
  payer: string;
  amount: string;
  requestId: string;
  issuedAt: number;
  /** Standard Base64 as produced by Verus `signmessage` — pass-through, never re-encoded. */
  signature: string;
  /** Raw base64 value of `X-V402-Extensions`, if present. Decoded/validated by the verifier. */
  extensionsRaw?: string;
}

/** The `.well-known/v402` discovery document. */
export interface DiscoveryDocument {
  specUrl?: string;
  supportedVersions: string[];
  defaultVersion: string;
  deprecatedVersions?: string[];
  /** version → ISO date */
  sunsetDates?: Record<string, string>;
  supportedExtensions?: string[];
}
