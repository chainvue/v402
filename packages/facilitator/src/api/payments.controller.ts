import { Body, Controller, HttpException, Inject, Post, UseGuards } from "@nestjs/common";
import { InjectMetric } from "@willsoto/nestjs-prometheus";
import type { Counter, Histogram } from "prom-client";
import type { IncomingPaymentRequest, SchemeVerifier, VerifierRegistry, VerifyError } from "@chainvue/v402-verifier";
import { parseSchemeHeader } from "@chainvue/v402-verifier";
import { BasicAuthGuard } from "../auth/basic-auth.guard.js";
import { V402_CONFIG } from "../config/config.module.js";
import type { FacilitatorConfig } from "../config/schema.js";
import { VERIFIER_REGISTRY } from "../core/core.module.js";
import {
  commitBodySchema,
  parseBody,
  paymentRequestBodySchema,
  rollbackBodySchema,
  type PaymentRequestBody,
} from "./dto.js";

/** VerifyError → HTTP response with the error's status; bigints stringified for JSON. */
function throwVerifyError(error: VerifyError): never {
  throw new HttpException({ ok: false, error }, error.httpStatus);
}

function toIncomingRequest(body: PaymentRequestBody): IncomingPaymentRequest {
  const request: IncomingPaymentRequest = {
    method: body.method,
    path: body.path,
    headers: body.headers,
  };
  if (body.rawBodyBase64 !== undefined) {
    request.rawBody = Buffer.from(body.rawBodyBase64, "base64");
  }
  return request;
}

/**
 * Middleware-facing payment API (plan § Facilitator API, normative for
 * spec/0.1/facilitator-api.md). All endpoints require the per-middleware
 * Basic token. reserve/commit/rollback are idempotent per requestId.
 */
@Controller("v1")
@UseGuards(BasicAuthGuard)
export class PaymentsController {
  constructor(
    @Inject(VERIFIER_REGISTRY) private readonly registry: VerifierRegistry,
    @Inject(V402_CONFIG) private readonly config: FacilitatorConfig,
    @InjectMetric("v402_requests_total") private readonly requestsTotal: Counter,
    @InjectMetric("v402_verify_duration_seconds") private readonly verifyDuration: Histogram,
    @InjectMetric("v402_balance_debited_total") private readonly balanceDebited: Counter,
    @InjectMetric("v402_late_commit_total") private readonly lateCommits: Counter,
  ) {}

  /** Resolve the scheme verifier from an X-V402-Scheme header value or explicit scheme name. */
  private verifierFor(schemeValue: string | undefined): SchemeVerifier {
    const name = parseSchemeHeader(schemeValue ?? this.config.defaultScheme).scheme;
    const verifier = this.registry.get(name);
    if (!verifier) {
      throwVerifyError({
        httpStatus: 402,
        code: "unsupported-scheme",
        message: `unsupported scheme: ${name}`,
        details: { supportedSchemes: this.registry.supportedSchemes() },
      });
    }
    return verifier;
  }

  private schemeFromHeaders(body: PaymentRequestBody): string | undefined {
    const value = body.headers["x-v402-scheme"] ?? body.headers["X-V402-Scheme"];
    return Array.isArray(value) ? value[0] : value;
  }

  @Post("verify")
  async verify(@Body() rawBody: unknown): Promise<unknown> {
    const body = parseBody(paymentRequestBodySchema, rawBody);
    const verifier = this.verifierFor(this.schemeFromHeaders(body));
    const stop = this.verifyDuration.startTimer({ mode: this.config.verifier.mode });
    const result = await verifier.verify(toIncomingRequest(body), body.policy);
    stop();
    this.requestsTotal.inc({ scheme: verifier.scheme, status: result.ok ? "verified" : result.error.code });
    if (!result.ok) throwVerifyError(result.error);
    return {
      ok: true,
      requestId: result.requestId,
      payer: result.payer,
      amountSats: result.amountSats.toString(),
    };
  }

  @Post("reserve")
  async reserve(@Body() rawBody: unknown): Promise<unknown> {
    const body = parseBody(paymentRequestBodySchema, rawBody);
    const verifier = this.verifierFor(this.schemeFromHeaders(body));
    const stop = this.verifyDuration.startTimer({ mode: this.config.verifier.mode });
    const result = await verifier.verifyAndReserve(toIncomingRequest(body), body.policy);
    stop();
    this.requestsTotal.inc({ scheme: verifier.scheme, status: result.ok ? "reserved" : result.error.code });
    if (!result.ok) throwVerifyError(result.error);
    this.balanceDebited.inc(Number(result.amountSats));
    return {
      ok: true,
      requestId: result.requestId,
      payer: result.payer,
      amountSats: result.amountSats.toString(),
      balanceAfterSats: result.balanceAfterSats.toString(),
    };
  }

  @Post("commit")
  async commit(@Body() rawBody: unknown): Promise<unknown> {
    const body = parseBody(commitBodySchema, rawBody);
    const verifier = this.verifierFor(body.scheme);
    const result = await verifier.commit(body.requestId, body.responseBytes);
    if (!result.ok) throwVerifyError(result.error);
    if (result.late) this.lateCommits.inc();
    return {
      ok: true,
      alreadyCommitted: result.alreadyCommitted,
      late: result.late,
      ...(result.balanceAfterSats !== undefined ? { balanceAfterSats: result.balanceAfterSats.toString() } : {}),
    };
  }

  @Post("rollback")
  async rollback(@Body() rawBody: unknown): Promise<unknown> {
    const body = parseBody(rollbackBodySchema, rawBody);
    const verifier = this.verifierFor(body.scheme);
    const result = await verifier.rollback(body.requestId);
    if (!result.ok) throwVerifyError(result.error);
    return { ok: true, alreadyRolledBack: result.alreadyRolledBack };
  }
}
