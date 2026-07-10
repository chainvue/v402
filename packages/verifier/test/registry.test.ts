import { describe, expect, it } from "vitest";
import { VerifierRegistry, parseSchemeHeader, type SchemeVerifier } from "../src/index.js";

function stubVerifier(scheme: string): SchemeVerifier {
  return {
    scheme,
    schemeVersions: ["0.1"],
    verifyAndReserve: async () => {
      throw new Error("not implemented");
    },
    commit: async () => {
      throw new Error("not implemented");
    },
    rollback: async () => {
      throw new Error("not implemented");
    },
  };
}

describe("VerifierRegistry", () => {
  it("registers and resolves schemes", () => {
    const registry = new VerifierRegistry();
    registry.register(stubVerifier("verus-prepaid-sig"));
    registry.register(stubVerifier("x-acme-credits"));
    expect(registry.get("verus-prepaid-sig")?.scheme).toBe("verus-prepaid-sig");
    expect(registry.get("nope")).toBeUndefined();
    expect(registry.supportedSchemes()).toEqual(["verus-prepaid-sig", "x-acme-credits"]);
  });

  it("throws on duplicate registration at boot time (misconfiguration guard)", () => {
    const registry = new VerifierRegistry();
    registry.register(stubVerifier("verus-prepaid-sig"));
    expect(() => registry.register(stubVerifier("verus-prepaid-sig"))).toThrow(/already registered/);
  });
});

describe("parseSchemeHeader", () => {
  it("parses bare scheme names", () => {
    expect(parseSchemeHeader("verus-prepaid-sig")).toEqual({ scheme: "verus-prepaid-sig" });
  });

  it("parses scheme/version form", () => {
    expect(parseSchemeHeader("verus-prepaid-sig/0.1")).toEqual({ scheme: "verus-prepaid-sig", version: "0.1" });
  });
});
