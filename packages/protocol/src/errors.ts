/**
 * Error codes are stable identifiers — adapters map them to HTTP responses,
 * so renaming one is a breaking change.
 */
export type V402ProtocolErrorCode =
  | "invalid-amount"
  | "invalid-field"
  | "invalid-extension-key"
  | "invalid-extension-value"
  | "extensions-unsorted"
  | "extensions-duplicate-key"
  | "invalid-extension-block"
  | "invalid-signature-encoding";

export class V402ProtocolError extends Error {
  readonly code: V402ProtocolErrorCode;

  constructor(code: V402ProtocolErrorCode, message: string) {
    super(message);
    this.name = "V402ProtocolError";
    this.code = code;
  }
}
