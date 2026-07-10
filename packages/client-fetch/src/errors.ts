export type V402ClientErrorCode =
  | "no-supported-scheme"
  | "invalid-402-response"
  | "unsupported-body-type"
  | "retries-exhausted"
  | "facilitator-error";

export class V402ClientError extends Error {
  readonly code: V402ClientErrorCode;
  readonly details?: Record<string, unknown>;

  constructor(code: V402ClientErrorCode, message: string, details?: Record<string, unknown>) {
    super(message);
    this.name = "V402ClientError";
    this.code = code;
    if (details !== undefined) this.details = details;
  }
}
