import { secp256k1 } from "@noble/curves/secp256k1.js";
import { verusIdentitySignDigest, verusSignDigest } from "./message-hash.js";
import { decodeIAddress } from "./wif.js";

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
  return signCompactBase64(verusSignDigest(message), privateKey);
}

/** RFC 6979 low-S ECDSA over a 32-byte digest, 65-byte recoverable compact form, Base64. */
function signCompactBase64(digest: Uint8Array, privateKey: Uint8Array): string {
  // extraEntropy: false = pure RFC 6979 — noble v2 defaults to hedged nonces,
  // verusd does not; byte-equality with the daemon requires determinism
  const signature = secp256k1.sign(digest, privateKey, { prehash: false, format: "recovered", extraEntropy: false });
  // noble "recovered" format: recovery byte || r(32) || s(32)
  const recovery = signature[0]!;
  const out = Buffer.alloc(65);
  out[0] = 27 + recovery + 4; // compressed
  Buffer.from(signature.subarray(1)).copy(out, 1);
  return out.toString("base64");
}

/**
 * Wrap a compact signature into the VerusID identity-signature envelope:
 * version 0x01 || signing height LE32 || sig count 0x01 || length 0x41 ||
 * compact65 (`CIdentitySignature` VERSION_VERUSID serialization). The inner
 * compact signature MUST sign the identity digest
 * (`verusIdentitySignDigest`), NOT the plain address digest — verifiers
 * recover the pubkey over the identity digest and resolve the identity's
 * primary addresses AT the embedded height.
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

export interface IdentitySignOptions {
  /** Signing block height, embedded in the signature (recent chain tip). */
  blockHeight: number;
  /** Chain/system i-address, e.g. iJhCezBExJHvtyH3fGhNnt2NhU4Ztkf2yq (VRSCTEST). */
  systemId: string;
  /** The signing identity's i-address, e.g. iGnQaDzEcrFWg3J9Jg5MqPKCwo52Din4Ma (v402test@). */
  identityAddress: string;
}

/**
 * Sign as a VerusID: compact-sign the identity digest (which binds chain,
 * height and identity — see `verusIdentitySignDigest`) and wrap it in the
 * identity-signature envelope. Verified against verusd verifymessage in the
 * gated integration suite.
 */
export function signIdentityMessage(message: string, privateKey: Uint8Array, options: IdentitySignOptions): string {
  const digest = verusIdentitySignDigest(
    message,
    decodeIAddress(options.systemId),
    options.blockHeight,
    decodeIAddress(options.identityAddress),
  );
  return wrapIdentitySignature(signCompactBase64(digest, privateKey), options.blockHeight);
}
