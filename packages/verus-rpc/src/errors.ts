/**
 * Error taxonomy — the split matters for the circuit breaker:
 *
 * - `VerusRpcError` — the daemon answered with a JSON-RPC error (bad identity,
 *   malformed signature, unknown tx, …). The node is HEALTHY; these must never
 *   count toward the circuit breaker, otherwise a client spamming malformed
 *   requests could trip it and deny service to everyone.
 * - `VerusRpcUnavailableError` — the node could not be reached or did not
 *   answer in time (network, timeout, open circuit, unparseable response).
 *   Adapters map this to HTTP 503.
 */
export class VerusRpcError extends Error {
  readonly code: number;
  readonly method: string;

  constructor(method: string, code: number, message: string) {
    super(`${method}: ${message} (code ${code})`);
    this.name = "VerusRpcError";
    this.code = code;
    this.method = method;
  }
}

export type UnavailabilityReason = "network" | "timeout" | "circuit-open" | "bad-response";

export class VerusRpcUnavailableError extends Error {
  readonly reason: UnavailabilityReason;

  constructor(reason: UnavailabilityReason, message: string) {
    super(message);
    this.name = "VerusRpcUnavailableError";
    this.reason = reason;
  }
}

/** Internal transport-level failure; mapped to VerusRpcUnavailableError by the client. */
export class TransportError extends Error {
  readonly reason: Extract<UnavailabilityReason, "network" | "bad-response">;

  constructor(reason: "network" | "bad-response", message: string) {
    super(message);
    this.name = "TransportError";
    this.reason = reason;
  }
}
