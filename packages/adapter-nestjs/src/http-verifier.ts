import type {
  CommitResult,
  IncomingPaymentRequest,
  RollbackResult,
  RoutePolicy,
  SchemeVerifier,
  VerifyAndReserveResult,
  VerifyError,
  VerifyResult,
} from "@chainvue/v402-verifier";

export interface HttpFacilitatorVerifierOptions {
  scheme: string;
  schemeVersions?: string[];
  /** Facilitator base URL, e.g. http://facilitator:3000 */
  baseUrl: string;
  authToken: string;
  middlewareId?: string;
  fetchImpl?: typeof fetch;
}

interface HttpResult {
  status: number;
  body: Record<string, unknown>;
}

/**
 * SchemeVerifier backed by the facilitator HTTP API — the "http" deployment
 * mode (plan § Facilitator API): identical interface to the in-process
 * verifier, so switching modes is a config change, not a rewrite. Network
 * failures surface as 503 verify-unavailable (client retries with the SAME
 * requestId per M5 — the facilitator's reserve is idempotent).
 */
export class HttpFacilitatorVerifier implements SchemeVerifier {
  readonly scheme: string;
  readonly schemeVersions: string[];

  private readonly baseUrl: string;
  private readonly authorization: string;
  private readonly fetchImpl: typeof fetch;

  constructor(options: HttpFacilitatorVerifierOptions) {
    this.scheme = options.scheme;
    this.schemeVersions = options.schemeVersions ?? ["0.1"];
    this.baseUrl = options.baseUrl.replace(/\/$/, "");
    this.authorization =
      "Basic " + Buffer.from(`${options.middlewareId ?? "middleware"}:${options.authToken}`).toString("base64");
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  private async post(pathname: string, body: unknown): Promise<HttpResult | { error: VerifyError }> {
    try {
      const response = await this.fetchImpl(`${this.baseUrl}${pathname}`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: this.authorization },
        body: JSON.stringify(body),
      });
      const text = await response.text();
      return { status: response.status, body: JSON.parse(text) as Record<string, unknown> };
    } catch (err) {
      return {
        error: {
          httpStatus: 503,
          code: "verify-unavailable",
          message: `facilitator unreachable: ${err instanceof Error ? err.message : String(err)}`,
          details: { retryAfterSec: 5 },
        },
      };
    }
  }

  private static remoteError(result: HttpResult): VerifyError {
    const remote = result.body["error"] as Partial<VerifyError> | undefined;
    return {
      httpStatus: result.status,
      code: remote?.code ?? "verify-unavailable",
      message: remote?.message ?? `facilitator answered ${result.status}`,
      ...(remote?.details !== undefined ? { details: remote.details } : {}),
    };
  }

  private static paymentBody(request: IncomingPaymentRequest, policy: RoutePolicy): Record<string, unknown> {
    return {
      method: request.method,
      path: request.path,
      headers: request.headers,
      ...(request.rawBody !== undefined ? { rawBodyBase64: Buffer.from(request.rawBody).toString("base64") } : {}),
      policy,
    };
  }

  async verify(request: IncomingPaymentRequest, policy: RoutePolicy): Promise<VerifyResult> {
    const result = await this.post("/v1/verify", HttpFacilitatorVerifier.paymentBody(request, policy));
    if ("error" in result) return { ok: false, error: result.error };
    if (result.status >= 300) return { ok: false, error: HttpFacilitatorVerifier.remoteError(result) };
    return {
      ok: true,
      requestId: result.body["requestId"] as string,
      payer: result.body["payer"] as string,
      amountSats: BigInt(result.body["amountSats"] as string),
    };
  }

  async verifyAndReserve(request: IncomingPaymentRequest, policy: RoutePolicy): Promise<VerifyAndReserveResult> {
    const result = await this.post("/v1/reserve", HttpFacilitatorVerifier.paymentBody(request, policy));
    if ("error" in result) return { ok: false, error: result.error };
    if (result.status >= 300) return { ok: false, error: HttpFacilitatorVerifier.remoteError(result) };
    return {
      ok: true,
      requestId: result.body["requestId"] as string,
      payer: result.body["payer"] as string,
      amountSats: BigInt(result.body["amountSats"] as string),
      balanceAfterSats: BigInt(result.body["balanceAfterSats"] as string),
    };
  }

  async commit(requestId: string, responseBytes: number): Promise<CommitResult> {
    const result = await this.post("/v1/commit", { requestId, responseBytes, scheme: this.scheme });
    if ("error" in result) return { ok: false, error: result.error };
    if (result.status >= 300) return { ok: false, error: HttpFacilitatorVerifier.remoteError(result) };
    return {
      ok: true,
      alreadyCommitted: result.body["alreadyCommitted"] === true,
      late: result.body["late"] === true,
      ...(typeof result.body["balanceAfterSats"] === "string"
        ? { balanceAfterSats: BigInt(result.body["balanceAfterSats"]) }
        : {}),
    };
  }

  async rollback(requestId: string): Promise<RollbackResult> {
    const result = await this.post("/v1/rollback", { requestId, scheme: this.scheme });
    if ("error" in result) return { ok: false, error: result.error };
    if (result.status >= 300) return { ok: false, error: HttpFacilitatorVerifier.remoteError(result) };
    return { ok: true, alreadyRolledBack: result.body["alreadyRolledBack"] === true };
  }
}
