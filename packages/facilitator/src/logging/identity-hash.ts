import { createHash } from "node:crypto";

/**
 * Identities are hashed in logs (plan § Observability): privacy-preserving
 * but stable for correlation. SHA-256 hex prefix, default 12 chars.
 */
export function hashIdentity(identityKey: string, length = 12): string {
  return createHash("sha256").update(identityKey, "utf8").digest("hex").slice(0, length);
}
