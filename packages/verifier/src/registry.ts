import type { SchemeVerifier } from "./types.js";

/**
 * Multi-scheme registry (plan § Multi-Scheme Architecture). Adding a scheme
 * is a `register()` call, not a refactor. Registration throws on name
 * conflicts — a config error routing to the wrong verifier must fail at
 * boot, not at request time.
 */
export class VerifierRegistry {
  private readonly verifiers = new Map<string, SchemeVerifier>();

  register(verifier: SchemeVerifier): void {
    if (this.verifiers.has(verifier.scheme)) {
      throw new Error(`scheme already registered: ${verifier.scheme}`);
    }
    this.verifiers.set(verifier.scheme, verifier);
  }

  get(scheme: string): SchemeVerifier | undefined {
    return this.verifiers.get(scheme);
  }

  supportedSchemes(): string[] {
    return [...this.verifiers.keys()];
  }
}

/**
 * `X-V402-Scheme` carries the scheme name, optionally with an explicit
 * scheme version (`verus-prepaid-sig` or `verus-prepaid-sig/0.1`).
 * NOTE: the version suffix is an implementation extension pending spec
 * clarification — M2 mandates a distinct `unsupported-scheme-version`
 * error, but the 0.1 wire format transmits no scheme version outside the
 * signed payload (which the server rebuilds rather than receives).
 */
export function parseSchemeHeader(value: string): { scheme: string; version?: string } {
  const slash = value.indexOf("/");
  if (slash === -1) return { scheme: value };
  return { scheme: value.slice(0, slash), version: value.slice(slash + 1) };
}
