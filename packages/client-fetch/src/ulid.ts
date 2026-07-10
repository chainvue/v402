import { randomBytes } from "node:crypto";

const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

/**
 * ULID generator (spec: requestId is a ULID — 26 chars Crockford base32,
 * 48-bit timestamp + 80-bit randomness). Uniqueness comes from the
 * randomness; no monotonic ordering is needed or attempted — parallel
 * requests each roll fresh entropy (Q9: full parallelism).
 */
export function ulid(timestamp: number = Date.now()): string {
  let time = Math.floor(timestamp);
  const chars = new Array<string>(26);
  for (let i = 9; i >= 0; i--) {
    chars[i] = CROCKFORD[time % 32]!;
    time = Math.floor(time / 32);
  }
  let random = BigInt("0x" + randomBytes(10).toString("hex")); // 80 bits
  for (let i = 25; i >= 10; i--) {
    chars[i] = CROCKFORD[Number(random & 31n)]!;
    random >>= 5n;
  }
  return chars.join("");
}
