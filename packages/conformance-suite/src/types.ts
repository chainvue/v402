export type MaybePromise<T> = T | Promise<T>;

/**
 * Identity state pinned by the conformance suite for identity-signature
 * cases (`v402test@`). Implementations without chain access verify identity
 * signatures against this — it mirrors what getidentity would return.
 */
export interface PinnedIdentity {
  name: string;
  identityAddress: string;
  systemId: string;
  primaryAddresses: string[];
  minimumSignatures: number;
}

export type WireFormatType = "payment402" | "paymentRequirement" | "discovery" | "paymentHeaders";

/**
 * The operations a v402 implementation exposes to the conformance runner.
 * Every operation is optional — categories whose operations are missing are
 * reported as skipped, so partial implementations (e.g. client-only) can
 * still prove conformance for what they implement.
 *
 * Error semantics: where a vector expects an error, the operation MUST throw
 * (or reject) with an error carrying a `code` property equal to the vector's
 * error identifier — the identifiers are part of the normative vectors.
 */
export interface ConformanceTarget {
  name: string;
  /** canonical.json + boundary canonicalize cases. */
  canonicalize?(payload: Record<string, unknown>, payloadType: "payment" | "balanceQuery"): MaybePromise<string>;
  /** extensions.json. */
  serializeExtensions?(fields: ReadonlyArray<{ key: string; value: string }>): MaybePromise<string>;
  parseExtensions?(block: string): MaybePromise<Array<{ key: string; value: string }>>;
  /** boundary.json amount cases; sats travel as decimal strings. */
  humanToSats?(human: string): MaybePromise<string>;
  satsToHuman?(sats: string): MaybePromise<string>;
  /** wire-format.json: schema/shape validation, claim echo for paymentHeaders. */
  validateWireFormat?(type: WireFormatType, value: unknown): MaybePromise<{ valid: boolean; claim?: unknown }>;
  /** signing.json: hex msgHash (the `hash` the daemon reports). */
  messageHash?(message: string): MaybePromise<string>;
  /** signing.json: base64 compact signature for an R-address key (WIF). */
  signMessage?(message: string, wif: string): MaybePromise<string>;
  /** signing.json + verification.json; identity is supplied for `…@` signers. */
  verifyMessage?(message: string, signature: string, signer: string, identity?: PinnedIdentity): MaybePromise<boolean>;
}

export type CaseStatus = "pass" | "fail" | "skip";

export interface CaseResult {
  name: string;
  status: CaseStatus;
  /** Failure explanation or skip reason. */
  detail?: string;
}

export interface CategoryResult {
  category: string;
  status: CaseStatus;
  cases: CaseResult[];
}

export interface ConformanceReport {
  target: string;
  specVersion: string;
  /** True when no case failed (skips do not fail a run). */
  ok: boolean;
  categories: CategoryResult[];
  summary: { pass: number; fail: number; skip: number };
}
