import { V402ProtocolError } from "./errors.js";

/**
 * Signature encoding (Q4): Verus `signmessage` returns standard Base64 — the
 * string travels bit-identically through `X-V402-Signature` into
 * `verifymessage`. These helpers only gate the encoding; they never decode or
 * re-encode.
 */
const BASE64_RE = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=|[A-Za-z0-9+/]{4})$/;

export function isBase64Signature(value: string): boolean {
  return BASE64_RE.test(value);
}

export function assertBase64Signature(value: string): void {
  if (!BASE64_RE.test(value)) {
    throw new V402ProtocolError("invalid-signature-encoding", "signature must be non-empty standard Base64 (not base64url)");
  }
}
