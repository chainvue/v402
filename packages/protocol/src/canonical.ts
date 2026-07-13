import { V402ProtocolError } from "./errors.js";
import { isValidHumanAmount } from "./amount.js";
import { serializeExtensionBlock } from "./extensions.js";
import { BALANCE_QUERY_CONTEXT, LEDGER_QUERY_CONTEXT, schemeContextLine } from "./version.js";
import type { BalanceQueryPayload, CanonicalPayload } from "./types.js";

/** ULID: Crockford base32, 26 chars, 128 bit (first char therefore 0–7). */
const ULID_RE = /^[0-7][0-9A-HJKMNP-TV-Z]{25}$/;

export function isValidUlid(value: string): boolean {
  return ULID_RE.test(value);
}
const SCHEME_NAME_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const SCHEME_VERSION_RE = /^\d+\.\d+$/;
const METHOD_RE = /^[A-Z]+$/;
const NETWORK_RE = /^[a-z0-9]+$/;
/** Whitespace/control characters would corrupt the line-based canonical form. */
// eslint-disable-next-line no-control-regex -- rejecting control chars is the wire rule
const LINE_SAFE_RE = /^[^\s\x00-\x1f\x7f]+$/;

function invalid(field: string, value: unknown, rule: string): never {
  throw new V402ProtocolError("invalid-field", `${field} ${rule}: ${JSON.stringify(value)}`);
}

function assertLineSafe(field: string, value: string): void {
  if (!LINE_SAFE_RE.test(value)) invalid(field, value, "must be non-empty without whitespace/control characters");
}

/** VerusID friendly name, e.g. "v402test.demoAgent@". Existence/charset rules are the verifier's job. */
function assertIdentity(field: string, value: string): void {
  assertLineSafe(field, value);
  if (!value.endsWith("@") || value.length < 2) invalid(field, value, "must be a VerusID friendly name ending in '@'");
}

/**
 * `path` verbatim rule (M1): request-target exactly as sent on the wire,
 * incl. query string. No normalization on either side — but dot-segments and
 * duplicate slashes are forbidden by spec, so both sides fail closed here.
 */
function assertPath(value: string): void {
  assertLineSafe("path", value);
  if (!value.startsWith("/")) invalid("path", value, "must start with '/'");
  const pathPart = value.split("?", 1)[0]!;
  if (pathPart.includes("//")) invalid("path", value, "must not contain duplicate slashes");
  if (pathPart.split("/").some((segment) => segment === "." || segment === "..")) {
    invalid("path", value, "must not contain dot-segments");
  }
}

function assertUnixSeconds(field: string, value: number): void {
  if (!Number.isSafeInteger(value) || value < 0) invalid(field, value, "must be a non-negative integer (Unix seconds)");
}

function assertRequestId(value: string): void {
  if (!ULID_RE.test(value)) invalid("requestId", value, "must be a ULID (26 chars, Crockford base32)");
}

/**
 * Build the exact byte string that gets signed (spec § Signed payload):
 * line 1 `<scheme>/<schemeVersion>`, the 11 core fields in fixed order,
 * then the alphabetically sorted extension section. LF separators, exact
 * `key: value` form, no trailing newline.
 *
 * Every field is validated — a payload this function rejects must never be
 * signed or verified.
 */
export function canonicalize(payload: CanonicalPayload): string {
  if (!SCHEME_NAME_RE.test(payload.scheme)) invalid("scheme", payload.scheme, "must match <network-family>-<mechanism>");
  if (!SCHEME_VERSION_RE.test(payload.schemeVersion)) invalid("schemeVersion", payload.schemeVersion, "must be MAJOR.MINOR");
  assertLineSafe("canonicalDomain", payload.canonicalDomain);
  if (!METHOD_RE.test(payload.method)) invalid("method", payload.method, "must be an uppercase HTTP method");
  assertPath(payload.path);
  if (!NETWORK_RE.test(payload.network)) invalid("network", payload.network, "must be a lowercase network identifier");
  assertLineSafe("asset", payload.asset);
  if (!isValidHumanAmount(payload.amount)) invalid("amount", payload.amount, "must be a human decimal amount string");
  assertIdentity("payer", payload.payer);
  assertIdentity("payTo", payload.payTo);
  assertRequestId(payload.requestId);
  assertUnixSeconds("issuedAt", payload.issuedAt);

  const lines = [
    schemeContextLine(payload.scheme, payload.schemeVersion),
    `canonicalDomain: ${payload.canonicalDomain}`,
    `method: ${payload.method}`,
    `path: ${payload.path}`,
    `scheme: ${payload.scheme}`,
    `network: ${payload.network}`,
    `asset: ${payload.asset}`,
    `amount: ${payload.amount}`,
    `payer: ${payload.payer}`,
    `payTo: ${payload.payTo}`,
    `requestId: ${payload.requestId}`,
    `issuedAt: ${payload.issuedAt}`,
  ].join("\n");

  if (payload.extensions === undefined || payload.extensions.length === 0) return lines;
  return `${lines}\n${serializeExtensionBlock(payload.extensions)}`;
}

/**
 * Canonical `v402-balance-query/0.1` payload (spec § Topup Instructions
 * Endpoint) — domain-separated from payment payloads via its own line 1.
 */
export function canonicalizeBalanceQuery(payload: BalanceQueryPayload): string {
  assertLineSafe("canonicalDomain", payload.canonicalDomain);
  if (!NETWORK_RE.test(payload.network)) invalid("network", payload.network, "must be a lowercase network identifier");
  assertIdentity("payer", payload.payer);
  assertRequestId(payload.requestId);
  assertUnixSeconds("issuedAt", payload.issuedAt);

  return [
    BALANCE_QUERY_CONTEXT,
    `canonicalDomain: ${payload.canonicalDomain}`,
    `network: ${payload.network}`,
    `payer: ${payload.payer}`,
    `requestId: ${payload.requestId}`,
    `issuedAt: ${payload.issuedAt}`,
  ].join("\n");
}

/**
 * Canonical `v402-ledger-query/0.1` payload (spec § Ledger Statement
 * Endpoint) — same fields as the balance query under its own context line.
 * Pagination parameters (afterId/limit) are deliberately OUTSIDE the
 * signature: they select what the AUTHENTICATED owner sees, never who may
 * see it, and the requestId replay protection already binds each signature
 * to a single use.
 */
export function canonicalizeLedgerQuery(payload: BalanceQueryPayload): string {
  assertLineSafe("canonicalDomain", payload.canonicalDomain);
  if (!NETWORK_RE.test(payload.network)) invalid("network", payload.network, "must be a lowercase network identifier");
  assertIdentity("payer", payload.payer);
  assertRequestId(payload.requestId);
  assertUnixSeconds("issuedAt", payload.issuedAt);

  return [
    LEDGER_QUERY_CONTEXT,
    `canonicalDomain: ${payload.canonicalDomain}`,
    `network: ${payload.network}`,
    `payer: ${payload.payer}`,
    `requestId: ${payload.requestId}`,
    `issuedAt: ${payload.issuedAt}`,
  ].join("\n");
}
