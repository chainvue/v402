/** Protocol (envelope) version — 402 response shape, discovery, headers. */
export const PROTOCOL_VERSION = "v402/0.1";

/** Registered scheme name of the Verus prepaid-signature scheme. */
export const SCHEME_VERUS_PREPAID_SIG = "verus-prepaid-sig";

/** Current scheme version of `verus-prepaid-sig`. Versions independently of the protocol. */
export const VERUS_PREPAID_SIG_VERSION = "0.1";

/**
 * Line 1 of a signed payment payload: `<scheme>/<schemeVersion>`.
 * For the MVP scheme: `verus-prepaid-sig/0.1`.
 */
export function schemeContextLine(scheme: string, schemeVersion: string): string {
  return `${scheme}/${schemeVersion}`;
}

/**
 * Line-1 context string of the signed balance query — deliberately distinct
 * from every scheme context line so a payment signature can never verify as a
 * balance query or vice versa (domain separation).
 */
export const BALANCE_QUERY_CONTEXT = "v402-balance-query/0.1";
/** Context line of the signed ledger-statement query (additive, 2026-07-14). */
export const LEDGER_QUERY_CONTEXT = "v402-ledger-query/0.1";
