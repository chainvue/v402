import { sha256 } from "@noble/hashes/sha2.js";

const BASE58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
const BASE58_MAP = new Map([...BASE58].map((c, i) => [c, BigInt(i)]));

/** Verus/Komodo WIF prefix (mainnet and testnet alike). */
const WIF_PREFIX = 0xbc;

function base58Decode(encoded: string): Uint8Array {
  let n = 0n;
  for (const char of encoded) {
    const value = BASE58_MAP.get(char);
    if (value === undefined) throw new Error(`invalid base58 character: ${JSON.stringify(char)}`);
    n = n * 58n + value;
  }
  let hex = n.toString(16);
  if (hex.length % 2 === 1) hex = "0" + hex;
  const body = n === 0n ? new Uint8Array(0) : Uint8Array.from(Buffer.from(hex, "hex"));
  let leadingZeros = 0;
  for (const char of encoded) {
    if (char !== "1") break;
    leadingZeros++;
  }
  const out = new Uint8Array(leadingZeros + body.length);
  out.set(body, leadingZeros);
  return out;
}

/** Verus identity (i-address) base58check version byte. */
const IADDRESS_PREFIX = 0x66;

/**
 * Decode a Verus i-address (identity or chain/system id, e.g.
 * `iGnQaDzEcrFWg3J9Jg5MqPKCwo52Din4Ma`) to its raw 20-byte hash160 — the
 * byte form serialized into identity-signature digests.
 */
export function decodeIAddress(address: string): Uint8Array {
  const decoded = base58Decode(address);
  if (decoded.length !== 25) {
    throw new Error(`invalid i-address: expected 25 bytes (version+hash160+checksum), got ${decoded.length}`);
  }
  const payload = decoded.subarray(0, 21);
  const checksum = decoded.subarray(21);
  const expected = sha256(sha256(payload)).subarray(0, 4);
  if (!Buffer.from(checksum).equals(Buffer.from(expected))) throw new Error("invalid i-address: checksum mismatch");
  if (payload[0] !== IADDRESS_PREFIX) {
    throw new Error(`invalid i-address: expected version 0x${IADDRESS_PREFIX.toString(16)}, got 0x${payload[0]!.toString(16)}`);
  }
  return Uint8Array.from(payload.subarray(1));
}

/** Verus/Komodo transparent address (R-address) base58check version byte. */
const RADDRESS_PREFIX = 0x3c;

/**
 * Decode a Verus transparent address (R-address, e.g.
 * `RXzn488JQaeEpo7iezaKiK1XLfRQzi2NWT`) to its raw 20-byte hash160 —
 * the form compared against recovered public keys during verification.
 */
export function decodeRAddress(address: string): Uint8Array {
  const decoded = base58Decode(address);
  if (decoded.length !== 25) {
    throw new Error(`invalid R-address: expected 25 bytes (version+hash160+checksum), got ${decoded.length}`);
  }
  const payload = decoded.subarray(0, 21);
  const checksum = decoded.subarray(21);
  const expected = sha256(sha256(payload)).subarray(0, 4);
  if (!Buffer.from(checksum).equals(Buffer.from(expected))) throw new Error("invalid R-address: checksum mismatch");
  if (payload[0] !== RADDRESS_PREFIX) {
    throw new Error(`invalid R-address: expected version 0x${RADDRESS_PREFIX.toString(16)}, got 0x${payload[0]!.toString(16)}`);
  }
  return Uint8Array.from(payload.subarray(1));
}

/**
 * Decode a Verus WIF private key: base58check(0xBC || privkey32 || 0x01).
 * Only compressed keys are supported — everything v402 publishes/uses is
 * compressed (incl. the reference test keys).
 */
export function decodeWif(wif: string): Uint8Array {
  const decoded = base58Decode(wif);
  if (decoded.length !== 38) {
    throw new Error(`invalid WIF: expected 38 bytes (prefix+key+compressed+checksum), got ${decoded.length}`);
  }
  const payload = decoded.subarray(0, 34);
  const checksum = decoded.subarray(34);
  const expected = sha256(sha256(payload)).subarray(0, 4);
  if (!Buffer.from(checksum).equals(Buffer.from(expected))) throw new Error("invalid WIF: checksum mismatch");
  if (payload[0] !== WIF_PREFIX) {
    throw new Error(`invalid WIF: expected Verus prefix 0x${WIF_PREFIX.toString(16)}, got 0x${payload[0]!.toString(16)}`);
  }
  if (payload[33] !== 0x01) throw new Error("invalid WIF: only compressed keys are supported");
  return Uint8Array.from(payload.subarray(1, 33));
}
