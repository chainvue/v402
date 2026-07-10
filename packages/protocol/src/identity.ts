/**
 * Canonical balance-account key for a VerusID friendly name.
 *
 * The Verus chain resolves identity names case-insensitively ("Fum@" and
 * "fum@" are the same identity), but v402 keys balances by string. Every
 * component that touches balance state (verifier lookups, deposit-watcher
 * attribution) MUST key through this function, otherwise a deposit credited
 * as "v402test.demoagent@" is invisible to a payer sending
 * "v402test.demoAgent@".
 *
 * Signature verification is NOT affected — the canonical payload keeps the
 * payer string exactly as the client signed it.
 */
export function normalizeIdentityKey(identity: string): string {
  return identity.trim().toLowerCase();
}
