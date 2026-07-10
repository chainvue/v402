import type { SpentRequestStatus } from "@chainvue/v402-storage";

/**
 * Framework-agnostic view of an incoming HTTP request. Adapters (NestJS,
 * later Hono/Express) translate their request object into this shape —
 * the verifier never sees framework types and never throws framework
 * exceptions (errors travel as result unions with an HTTP status mapping).
 */
export interface IncomingPaymentRequest {
  method: string;
  /** Request-target verbatim as sent on the wire, incl. query string (M1). */
  path: string;
  /** Raw header map; node-style lowercased keys are fine. */
  headers: Record<string, string | string[] | undefined>;
  /** Raw body bytes — required to enforce a `required` bodyHash policy. */
  rawBody?: Uint8Array;
}

/** Per-route pricing + body-binding policy, resolved by the adapter from its route config. */
export interface RoutePolicy {
  /**
   * Current price as the exact decimal string advertised in the 402.
   * Compared byte-wise against `X-V402-Amount` (M6) and embedded verbatim
   * into the rebuilt canonical payload.
   */
  priceHuman: string;
  /** `required` rejects body-carrying requests without scheme.bodyHash; `ignored` skips verification entirely. */
  bodyHashPolicy: "required" | "optional" | "ignored";
}

/** Stable machine-readable error identifiers — part of the public wire behavior. */
export type VerifyErrorCode =
  | "invalid-headers"
  | "unsupported-scheme"
  | "unsupported-scheme-version"
  | "price-mismatch"
  | "extensions-too-large"
  | "invalid-extensions"
  | "unknown-scheme-extension"
  | "reserved-extension"
  | "body-hash-required"
  | "body-hash-mismatch"
  | "invalid-body-hash"
  | "timestamp-out-of-window"
  | "invalid-request"
  | "blocked"
  | "invalid-signature"
  | "verify-unavailable"
  | "replay"
  | "insufficient-balance"
  | "no-balance"
  | "unknown-request"
  | "invalid-state";

export interface VerifyError {
  /** 400 | 402 | 403 | 409 | 503 — the adapter maps this straight onto the response. */
  httpStatus: number;
  code: VerifyErrorCode;
  message: string;
  /** Structured extras for the response body (previousStatus, balance, …). */
  details?: Record<string, unknown>;
}

/** Stateless verification (plan: POST /v1/verify) — everything up to but excluding the debit. */
export type VerifyResult =
  | {
      ok: true;
      requestId: string;
      /** Normalized identity key (balance account) — not necessarily the payer string as signed. */
      payer: string;
      amountSats: bigint;
    }
  | { ok: false; error: VerifyError };

export type VerifyAndReserveResult =
  | {
      ok: true;
      requestId: string;
      /** Normalized identity key (balance account) — not necessarily the payer string as signed. */
      payer: string;
      amountSats: bigint;
      balanceAfterSats: bigint;
    }
  | { ok: false; error: VerifyError };

export type CommitResult =
  | {
      ok: true;
      /** True when the request was already committed (idempotent repeat). */
      alreadyCommitted: boolean;
      /** B3: true when this was a late commit after the reaper refunded — money re-debited. */
      late: boolean;
      /** Present on late commits; MAY be negative (ops flag). */
      balanceAfterSats?: bigint;
    }
  | { ok: false; error: VerifyError };

export type RollbackResult =
  | {
      ok: true;
      /** True when the request was already rolled back (idempotent repeat). */
      alreadyRolledBack: boolean;
    }
  | { ok: false; error: VerifyError };

/**
 * One payment scheme implementation (plan § Multi-Scheme Architecture).
 * Method shapes mirror the facilitator HTTP API so in-process and HTTP
 * deployment stay interchangeable.
 */
export interface SchemeVerifier {
  readonly scheme: string;
  readonly schemeVersions: string[];
  /** Stateless: all checks incl. the signature RPC, no storage writes (POST /v1/verify). */
  verify(request: IncomingPaymentRequest, policy: RoutePolicy): Promise<VerifyResult>;
  verifyAndReserve(request: IncomingPaymentRequest, policy: RoutePolicy): Promise<VerifyAndReserveResult>;
  commit(requestId: string, responseBytes: number): Promise<CommitResult>;
  rollback(requestId: string): Promise<RollbackResult>;
}

export type { SpentRequestStatus };
