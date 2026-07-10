import { sha256 } from "@noble/hashes/sha2.js";

const VERUS_DATA_SIGNATURE_PREFIX = "Verus signed data:\n";

/**
 * verusd's message-hash pipeline, determined empirically against v1.2.17
 * (recovered pubkey from known-good signatures; see docs/RISKS.md step 20):
 *
 *   msgHash = SHA-256( compactSize(len(message)) || utf8(message) )     — the "hash" the RPC reports
 *   digest  = SHA-256( compactSize(len(magic)) || magic || msgHash )    — what actually gets ECDSA-signed
 *
 * with magic = "Verus signed data:\n". Byte-compatibility is proven by
 * reproducing the reference signing vectors exactly.
 */
export function verusMessageHash(message: string): Uint8Array {
  const body = Buffer.from(message, "utf8");
  return sha256(Buffer.concat([compactSize(body.byteLength), body]));
}

/** The digest verusd's ECDSA actually signs (magic-wrapped message hash). */
export function verusSignDigest(message: string): Uint8Array {
  const magic = Buffer.from(VERUS_DATA_SIGNATURE_PREFIX, "utf8");
  return sha256(Buffer.concat([compactSize(magic.byteLength), magic, Buffer.from(verusMessageHash(message))]));
}

/**
 * The digest a VerusID identity signature actually signs. Unlike address
 * signatures, the identity digest additionally binds the chain (systemID),
 * the signing block height, and the identity itself — per
 * `CIdentitySignature::IdentitySignatureHash` (VERSION_VERUSID path,
 * VerusCoin src/pbaas/crosschainrpc.cpp):
 *
 *   digest = SHA-256( compactSize(len(magic)) || magic
 *                     || systemID(20 raw bytes)
 *                     || blockHeight(uint32 LE)
 *                     || idID(20 raw bytes)
 *                     || msgHash(32) )
 *
 * systemID/idID are the base58check payloads of the chain and identity
 * i-addresses; msgHash is `verusMessageHash(message)`. Verification resolves
 * the identity's primary addresses AT blockHeight, so wrapping an address
 * signature without this binding can never verify against an identity.
 */
export function verusIdentitySignDigest(
  message: string,
  systemId: Uint8Array,
  blockHeight: number,
  identityId: Uint8Array,
): Uint8Array {
  if (systemId.byteLength !== 20) throw new Error("systemId must be 20 raw bytes (decoded i-address)");
  if (identityId.byteLength !== 20) throw new Error("identityId must be 20 raw bytes (decoded i-address)");
  if (!Number.isSafeInteger(blockHeight) || blockHeight <= 0 || blockHeight > 0xffff_ffff) {
    throw new Error("blockHeight must be a positive uint32");
  }
  const magic = Buffer.from(VERUS_DATA_SIGNATURE_PREFIX, "utf8");
  const height = Buffer.alloc(4);
  height.writeUInt32LE(blockHeight);
  return sha256(
    Buffer.concat([
      compactSize(magic.byteLength),
      magic,
      Buffer.from(systemId),
      height,
      Buffer.from(identityId),
      Buffer.from(verusMessageHash(message)),
    ]),
  );
}

function compactSize(n: number): Buffer {
  if (n < 253) return Buffer.from([n]);
  if (n <= 0xffff) {
    const b = Buffer.alloc(3);
    b[0] = 253;
    b.writeUInt16LE(n, 1);
    return b;
  }
  const b = Buffer.alloc(5);
  b[0] = 254;
  b.writeUInt32LE(n, 1);
  return b;
}
