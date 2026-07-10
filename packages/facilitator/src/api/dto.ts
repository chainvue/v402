import { BadRequestException } from "@nestjs/common";
import { z } from "zod";

/**
 * Request bodies of the facilitator HTTP API (normative shapes for
 * spec/0.1/facilitator-api.md). Validation errors → 400 `invalid-body`
 * with the flattened Zod issues.
 */

export const routePolicySchema = z.object({
  priceHuman: z.string().min(1),
  bodyHashPolicy: z.enum(["required", "optional", "ignored"]).default("optional"),
});

/** Shared body of POST /v1/verify and /v1/reserve — the middleware forwards the payment-relevant request parts. */
export const paymentRequestBodySchema = z.object({
  method: z.string().min(1),
  /** Request-target verbatim as received by the middleware (M1). */
  path: z.string().min(1),
  headers: z.record(z.string(), z.union([z.string(), z.array(z.string())])),
  /** Raw request body, base64 — required for bodyHash enforcement. */
  rawBodyBase64: z.string().optional(),
  policy: routePolicySchema,
});
export type PaymentRequestBody = z.infer<typeof paymentRequestBodySchema>;

export const commitBodySchema = z.object({
  requestId: z.string().min(1),
  responseBytes: z.number().int().nonnegative().default(0),
  /** Defaults to the configured defaultScheme. */
  scheme: z.string().min(1).optional(),
});
export type CommitBody = z.infer<typeof commitBodySchema>;

export const rollbackBodySchema = z.object({
  requestId: z.string().min(1),
  scheme: z.string().min(1).optional(),
});
export type RollbackBody = z.infer<typeof rollbackBodySchema>;

export function parseBody<T>(schema: z.ZodType<T>, body: unknown): T {
  const result = schema.safeParse(body);
  if (!result.success) {
    throw new BadRequestException({
      ok: false,
      error: { code: "invalid-body", message: "request body validation failed", issues: result.error.issues },
    });
  }
  return result.data;
}
