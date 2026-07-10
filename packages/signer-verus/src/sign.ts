import { secp256k1 } from "@noble/curves/secp256k1.js";
import { verusSignDigest } from "./message-hash.js";

/**
 * Sign a message compatibly with `verusd signmessage <R-address>`: RFC 6979
 * deterministic ECDSA (low-S) over the magic-wrapped Verus sign digest,
 * encoded as the 65-byte recoverable compact signature (header = 27 +
 * recovery + 4 for compressed keys), Base64.
 *
 * NOT byte-identical to the daemon: verusd derives its RFC 6979 nonce with a
 * non-standard variant (empirically: matches neither plain RFC6979(priv,
 * digest) nor the common libsecp256k1 forms). Both signatures are valid over
 * the same digest — verifymessage is recovery-based, so interop is unaffected;
 * validated against the reference vectors by pubkey recovery and against the
 * daemon by verifymessage in the gated integration suite.
 */
export function signAddressMessage(message: string, privateKey: Uint8Array): string {
  const hash = verusSignDigest(message);
  // extraEntropy: false = pure RFC 6979 — noble v2 defaults to hedged nonces,
  // verusd does not; byte-equality with the daemon requires determinism
  const signature = secp256k1.sign(hash, privateKey, { prehash: false, format: "recovered", extraEntropy: false });
  // noble "recovered" format: recovery byte || r(32) || s(32)
  const recovery = signature[0]!;
  const out = Buffer.alloc(65);
  out[0] = 27 + recovery + 4; // compressed
  Buffer.from(signature.subarray(1)).copy(out, 1);
  return out.toString("base64");
}

/**
 * Wrap a compact address signature into the VerusID identity-signature
 * format (empirically: version 0x01 || signing height LE32 || sig count 0x01
 * || length 0x41 || compact65). Verifiers resolve the identity's primary
 * addresses AT the given height, so the height must be recent enough to
 * reflect the current keys — and never in the future.
 */
export function wrapIdentitySignature(compactSignatureBase64: string, blockHeight: number): string {
  const compact = Buffer.from(compactSignatureBase64, "base64");
  if (compact.length !== 65) throw new Error(`expected a 65-byte compact signature, got ${compact.length}`);
  if (!Number.isSafeInteger(blockHeight) || blockHeight <= 0) throw new Error("blockHeight must be a positive integer");
  const out = Buffer.alloc(1 + 4 + 1 + 1 + 65);
  out[0] = 0x01; // version
  out.writeUInt32LE(blockHeight, 1);
  out[5] = 0x01; // one signature
  out[6] = 0x41; // 65-byte vector entry
  compact.copy(out, 7);
  return out.toString("base64");
}

/** Sign as a VerusID: address-style compact signature wrapped with the signing height. */
export function signIdentityMessage(message: string, privateKey: Uint8Array, blockHeight: number): string {
  return wrapIdentitySignature(signAddressMessage(message, privateKey), blockHeight);
}
