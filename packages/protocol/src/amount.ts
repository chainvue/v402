import { V402ProtocolError } from "./errors.js";

/**
 * Amount representation (Q3): `bigint` satoshis internally, human decimal
 * strings at all boundaries. 1 VRSC = 100_000_000 sats, exact arithmetic only.
 */
export const AMOUNT_DECIMALS = 8;
export const SATS_PER_COIN = 100_000_000n;

/**
 * Wire grammar for human amounts: non-negative decimal, no leading zeros in
 * the integer part, `.` separator, 1–8 fraction digits. Trailing fraction
 * zeros are allowed ("1.99999000") — amounts are compared/signed byte-verbatim,
 * never normalized.
 */
const HUMAN_AMOUNT_RE = /^(?:0|[1-9]\d*)(?:\.\d{1,8})?$/;

export function isValidHumanAmount(value: string): boolean {
  return HUMAN_AMOUNT_RE.test(value);
}

/** "0.001" → 100000n. Throws `V402ProtocolError("invalid-amount")` on any deviation from the wire grammar. */
export function humanToSats(value: string): bigint {
  if (!HUMAN_AMOUNT_RE.test(value)) {
    throw new V402ProtocolError("invalid-amount", `not a valid human amount string: ${JSON.stringify(value)}`);
  }
  const [whole, fraction = ""] = value.split(".");
  const fractionPadded = fraction.padEnd(AMOUNT_DECIMALS, "0");
  return BigInt(whole!) * SATS_PER_COIN + BigInt(fractionPadded);
}

/**
 * 100000n → "0.001" — minimal form (trailing fraction zeros trimmed).
 * Negative inputs are supported for internal ledger use; they are never valid
 * on the wire.
 */
export function satsToHuman(sats: bigint): string {
  const sign = sats < 0n ? "-" : "";
  const abs = sats < 0n ? -sats : sats;
  const whole = abs / SATS_PER_COIN;
  const fraction = abs % SATS_PER_COIN;
  if (fraction === 0n) return `${sign}${whole}`;
  const fractionStr = fraction.toString().padStart(AMOUNT_DECIMALS, "0").replace(/0+$/, "");
  return `${sign}${whole}.${fractionStr}`;
}
