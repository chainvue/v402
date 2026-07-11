import { secp256k1 } from "@noble/curves/secp256k1.js";
import { ripemd160 } from "@noble/hashes/legacy.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { verusIdentitySignDigest, verusSignDigest } from "./message-hash.js";
import { decodeIAddress, decodeRAddress } from "./wif.js";

/**
 * Offline signature verification — the recovery-based counterpart to sign.ts,
 * byte-compatible with `verusd verifymessage` (validated against the
 * daemon-confirmed reference vectors and, in the gated integration suite,
 * against a live daemon).
 *
 * Address signatures need no chain state at all. Identity signatures need the
 * identity's state (primary addresses, minimumsignatures, revocation) — the
 * CALLER supplies it, which is exactly where the checklatest decision from D2
 * lives: pass the LATEST identity state and key rotation/revocation take
 * effect immediately (modulo the provider's cache TTL).
 */

/**
 * Verify a `verusd signmessage <R-address>`-style signature: recover the
 * public key from the 65-byte compact signature over the magic-wrapped sign
 * digest and compare its hash160 against the address. Malformed input
 * verifies as false (fail closed), like the daemon's verifymessage.
 */
export function verifyAddressSignature(message: string, signatureBase64: string, address: string): boolean {
  let expected: Uint8Array;
  try {
    expected = decodeRAddress(address);
  } catch {
    return false;
  }
  const recovered = recoverHash160(verusSignDigest(message), fromBase64(signatureBase64));
  return recovered !== null && Buffer.from(recovered).equals(Buffer.from(expected));
}

/** Identity signature envelope (`CIdentitySignature` VERSION_VERUSID), parsed. */
export interface ParsedIdentitySignature {
  version: number;
  /** Signing block height embedded in the envelope (bound into the digest). */
  blockHeight: number;
  /** The 65-byte compact signatures (one per signing primary address). */
  signatures: Uint8Array[];
}

/**
 * Parse the identity-signature envelope: version 0x01 || height LE32 ||
 * compactSize sig count || per signature compactSize length (0x41) || bytes.
 * Throws on malformed input; `verifyIdentitySignature` maps that to a
 * fail-closed result.
 */
export function parseIdentitySignature(signatureBase64: string): ParsedIdentitySignature {
  const raw = fromBase64(signatureBase64);
  if (raw.length < 7) throw new Error("identity signature too short");
  const version = raw[0]!;
  if (version !== 0x01) throw new Error(`unsupported identity signature version 0x${version.toString(16)}`);
  const blockHeight = Buffer.from(raw).readUInt32LE(1);
  let offset = 5;
  const count = readCompactSize(raw, offset);
  offset = count.next;
  if (count.value === 0 || count.value > 0xff) throw new Error(`implausible signature count ${count.value}`);
  const signatures: Uint8Array[] = [];
  for (let i = 0; i < count.value; i++) {
    const len = readCompactSize(raw, offset);
    offset = len.next;
    if (len.value !== 65) throw new Error(`expected 65-byte compact signature, got ${len.value}`);
    if (offset + 65 > raw.length) throw new Error("identity signature truncated");
    signatures.push(Uint8Array.from(raw.subarray(offset, offset + 65)));
    offset += 65;
  }
  if (offset !== raw.length) throw new Error("trailing bytes after identity signature");
  return { version, blockHeight, signatures };
}

/**
 * Identity state needed to verify an identity signature — the offline
 * equivalent of what verifymessage resolves via getidentity. With
 * checklatest semantics this is the LATEST chain state.
 */
export interface IdentityState {
  /** The identity's i-address (serialized into the signed digest). */
  identityAddress: string;
  /** Primary addresses (R-addresses); recovered signers must be among them. */
  primaryAddresses: string[];
  /** How many distinct primary addresses must have signed. */
  minimumSignatures: number;
  /** Revoked identities never verify (checklatest semantics). */
  revoked?: boolean;
}

export interface IdentityVerification {
  valid: boolean;
  /** Informative failure reason — do not branch on the text. */
  reason?: string;
  /** Embedded signing height (0 when the envelope could not be parsed). */
  blockHeight: number;
  /** Distinct primary addresses with a valid recovered signature. */
  matchedAddresses: string[];
}

/**
 * Verify a VerusID identity signature against a known identity state:
 * rebuild the identity digest (chain + embedded height + identity + message),
 * recover a public key per compact signature, and count distinct matching
 * primary addresses against minimumsignatures. Fail-closed on any malformed
 * input.
 */
export function verifyIdentitySignature(
  message: string,
  signatureBase64: string,
  systemId: string,
  state: IdentityState,
): IdentityVerification {
  if (state.revoked) return { valid: false, reason: "identity is revoked", blockHeight: 0, matchedAddresses: [] };
  let parsed: ParsedIdentitySignature;
  try {
    parsed = parseIdentitySignature(signatureBase64);
  } catch (err) {
    return { valid: false, reason: `malformed envelope: ${(err as Error).message}`, blockHeight: 0, matchedAddresses: [] };
  }
  let digest: Uint8Array;
  const primaries = new Map<string, Uint8Array>();
  try {
    digest = verusIdentitySignDigest(
      message,
      decodeIAddress(systemId),
      parsed.blockHeight,
      decodeIAddress(state.identityAddress),
    );
    for (const address of state.primaryAddresses) primaries.set(address, decodeRAddress(address));
  } catch (err) {
    return { valid: false, reason: (err as Error).message, blockHeight: parsed.blockHeight, matchedAddresses: [] };
  }

  const matched = new Set<string>();
  for (const compact of parsed.signatures) {
    const recovered = recoverHash160(digest, compact);
    if (recovered === null) continue;
    for (const [address, hash] of primaries) {
      if (Buffer.from(recovered).equals(Buffer.from(hash))) matched.add(address);
    }
  }

  const required = Math.max(1, state.minimumSignatures);
  if (matched.size < required) {
    return {
      valid: false,
      reason: `${matched.size} of ${required} required primary-address signatures`,
      blockHeight: parsed.blockHeight,
      matchedAddresses: [...matched],
    };
  }
  return { valid: true, blockHeight: parsed.blockHeight, matchedAddresses: [...matched] };
}

/**
 * Recover the signer's hash160 from a Verus 65-byte compact signature
 * (header = 27 + recovery [+ 4 if compressed]) over a 32-byte digest.
 * Returns null when the signature does not recover (fail closed).
 */
function recoverHash160(digest: Uint8Array, compact: Uint8Array): Uint8Array | null {
  if (compact.length !== 65) return null;
  const header = compact[0]!;
  if (header < 27 || header > 34) return null;
  const compressed = header >= 31;
  const recovery = (header - 27) & 3;
  try {
    // noble "recovered" layout: recovery byte || r(32) || s(32)
    const recoverable = new Uint8Array(65);
    recoverable[0] = recovery;
    recoverable.set(compact.subarray(1), 1);
    const point = secp256k1.Signature.fromBytes(recoverable, "recovered").recoverPublicKey(digest);
    return ripemd160(sha256(point.toBytes(compressed)));
  } catch {
    return null;
  }
}

function fromBase64(value: string): Uint8Array {
  // Buffer.from tolerates malformed base64 by truncating — the strict length
  // checks on every consumer (65-byte compact, envelope structure) fail closed.
  return Uint8Array.from(Buffer.from(value, "base64"));
}

function readCompactSize(raw: Uint8Array, offset: number): { value: number; next: number } {
  if (offset >= raw.length) throw new Error("truncated compactSize");
  const first = raw[offset]!;
  if (first < 253) return { value: first, next: offset + 1 };
  if (first === 253) {
    if (offset + 3 > raw.length) throw new Error("truncated compactSize");
    return { value: Buffer.from(raw).readUInt16LE(offset + 1), next: offset + 3 };
  }
  throw new Error("implausibly large compactSize in identity signature");
}
