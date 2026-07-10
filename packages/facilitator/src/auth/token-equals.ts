import { timingSafeEqual } from "node:crypto";

/**
 * Constant-time token comparison; an empty expected token never matches
 * (unconfigured = disabled, fail closed). Used by the auth guards and the
 * throttler's auth-bypass so no code path becomes a timing oracle.
 */
export function tokenEquals(provided: string, expected: string): boolean {
  if (expected === "") return false;
  const providedBuf = Buffer.from(provided, "utf8");
  const expectedBuf = Buffer.from(expected, "utf8");
  return providedBuf.length === expectedBuf.length && timingSafeEqual(providedBuf, expectedBuf);
}

/** Extract the Basic password (token) from an Authorization header value, if any. */
export function basicPassword(header: string): string | undefined {
  if (!header.startsWith("Basic ")) return undefined;
  const decoded = Buffer.from(header.slice("Basic ".length), "base64").toString("utf8");
  const separator = decoded.indexOf(":");
  return separator === -1 ? "" : decoded.slice(separator + 1);
}
