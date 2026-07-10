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
 * `X-V402-Scheme` carries `<scheme>/<schemeVersion>` (normative, decision
 * D1) — byte-identical to payload line 1, so the server can decide the
 * distinct `unsupported-scheme-version` error (M2). Conforming clients MUST
 * send the versioned form; servers MUST accept a bare scheme name as that
 * scheme's default version (compatibility).
 */
export function parseSchemeHeader(value: string): { scheme: string; version?: string } {
  const slash = value.indexOf("/");
  if (slash === -1) return { scheme: value };
  return { scheme: value.slice(0, slash), version: value.slice(slash + 1) };
}
