import { z } from "zod";
import { isValidHumanAmount } from "./amount.js";
import { isValidUlid } from "./canonical.js";
import { isBase64Signature } from "./signature.js";
import { V402_HEADERS } from "./headers.js";
import type { PaymentClaim } from "./types.js";

/**
 * Wire validation (boundary only). Wire objects are parsed loose — a MINOR
 * protocol version may add optional fields, and rejecting unknown keys would
 * break forward compatibility.
 */

export const humanAmountSchema = z.string().refine(isValidHumanAmount, "must be a human decimal amount string");
export const ulidSchema = z.string().refine(isValidUlid, "must be a ULID (26 chars, Crockford base32)");
export const identitySchema = z
  .string()
  .regex(/^[^\s\x00-\x1f\x7f]+@$/, "must be a VerusID friendly name ending in '@'");
export const unixSecondsSchema = z.number().int().nonnegative();

/** One fully validated `accepts` entry (validate the entry you picked, not the whole array). */
export const paymentRequirementSchema = z.looseObject({
  scheme: z.string().min(1),
  schemeVersion: z.string().regex(/^\d+\.\d+$/),
  network: z.string().min(1),
  asset: z.string().min(1),
  amount: humanAmountSchema,
  amountUnit: z.literal("human"),
  payTo: identitySchema,
  facilitator: z.string().min(1),
  requiredHeaders: z.array(z.string().min(1)).min(1),
  canonicalDomain: z.string().min(1),
  topup: z
    .looseObject({
      depositAddress: identitySchema,
      attribution: z.literal("sender-verusid"),
    })
    .optional(),
});

/**
 * The 402 envelope. Entries are only shape-checked here — an unknown scheme
 * with fields we can't interpret must not make the whole response unparseable.
 */
export const payment402ResponseSchema = z.looseObject({
  version: z.string().min(1),
  accepts: z.array(
    z.looseObject({
      scheme: z.string().min(1),
      schemeVersion: z.string().min(1),
    }),
  ),
});

/** `.well-known/v402` discovery document. */
export const discoveryDocumentSchema = z.looseObject({
  specUrl: z.string().min(1).optional(),
  supportedVersions: z.array(z.string().min(1)).min(1),
  defaultVersion: z.string().min(1),
  deprecatedVersions: z.array(z.string().min(1)).optional(),
  sunsetDates: z.record(z.string(), z.string()).optional(),
  supportedExtensions: z.array(z.string().min(1)).optional(),
});

export type ParsePaymentHeadersResult =
  | { ok: true; claim: PaymentClaim }
  | { ok: false; error: string };

const ISSUED_AT_RE = /^(?:0|[1-9]\d*)$/;

/**
 * Extract + validate the `X-V402-*` headers into a `PaymentClaim`.
 * Case-insensitive lookup (Node lowercases incoming header names); repeated
 * payment headers are rejected — fail closed, never pick one of two values.
 */
export function parsePaymentHeaders(
  headers: Record<string, string | string[] | undefined>,
): ParsePaymentHeadersResult {
  const byName = new Map<string, string | string[]>();
  for (const [name, value] of Object.entries(headers)) {
    if (value !== undefined) byName.set(name.toLowerCase(), value);
  }

  const single = (name: string): string | { error: string } => {
    const value = byName.get(name.toLowerCase());
    if (value === undefined) return { error: `missing required header: ${name}` };
    if (Array.isArray(value)) {
      if (value.length !== 1) return { error: `header must not repeat: ${name}` };
      return value[0]!;
    }
    return value;
  };

  const read: Record<string, string> = {};
  for (const name of [
    V402_HEADERS.scheme,
    V402_HEADERS.payer,
    V402_HEADERS.amount,
    V402_HEADERS.requestId,
    V402_HEADERS.issuedAt,
    V402_HEADERS.signature,
  ]) {
    const result = single(name);
    if (typeof result !== "string") return { ok: false, error: result.error };
    read[name] = result;
  }

  const payer = read[V402_HEADERS.payer]!;
  if (!identitySchema.safeParse(payer).success) {
    return { ok: false, error: `${V402_HEADERS.payer} must be a VerusID friendly name ending in '@'` };
  }
  const amount = read[V402_HEADERS.amount]!;
  if (!isValidHumanAmount(amount)) {
    return { ok: false, error: `${V402_HEADERS.amount} must be a human decimal amount string` };
  }
  const requestId = read[V402_HEADERS.requestId]!;
  if (!isValidUlid(requestId)) {
    return { ok: false, error: `${V402_HEADERS.requestId} must be a ULID` };
  }
  const issuedAtRaw = read[V402_HEADERS.issuedAt]!;
  if (!ISSUED_AT_RE.test(issuedAtRaw) || !Number.isSafeInteger(Number(issuedAtRaw))) {
    return { ok: false, error: `${V402_HEADERS.issuedAt} must be Unix seconds (non-negative integer)` };
  }
  const signature = read[V402_HEADERS.signature]!;
  if (!isBase64Signature(signature)) {
    return { ok: false, error: `${V402_HEADERS.signature} must be standard Base64` };
  }
  const scheme = read[V402_HEADERS.scheme]!;
  if (scheme.length === 0) {
    return { ok: false, error: `${V402_HEADERS.scheme} must not be empty` };
  }

  const claim: PaymentClaim = {
    scheme,
    payer,
    amount,
    requestId,
    issuedAt: Number(issuedAtRaw),
    signature,
  };

  const extensions = byName.get(V402_HEADERS.extensions.toLowerCase());
  if (extensions !== undefined) {
    if (Array.isArray(extensions)) {
      if (extensions.length !== 1) return { ok: false, error: `header must not repeat: ${V402_HEADERS.extensions}` };
      claim.extensionsRaw = extensions[0]!;
    } else {
      claim.extensionsRaw = extensions;
    }
  }

  return { ok: true, claim };
}
