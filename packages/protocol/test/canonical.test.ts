import { describe, expect, it } from "vitest";
import {
  V402ProtocolError,
  canonicalize,
  canonicalizeBalanceQuery,
  isValidUlid,
  type CanonicalPayload,
} from "../src/index.js";

const REQUEST_ID = "01H8XG7Q4M2N8P5R7T3V9WXYZA";

const basePayload: CanonicalPayload = {
  scheme: "verus-prepaid-sig",
  schemeVersion: "0.1",
  canonicalDomain: "explorer.example.com",
  method: "GET",
  path: "/api/tx/abc",
  network: "vrsctest",
  asset: "VRSCTEST",
  amount: "0.001",
  payer: "v402test.demoAgent@",
  payTo: "explorerAPI@",
  requestId: REQUEST_ID,
  issuedAt: 1783650000,
};

function errorCode(fn: () => unknown): string {
  try {
    fn();
  } catch (err) {
    if (err instanceof V402ProtocolError) return err.code;
    throw err;
  }
  throw new Error("expected V402ProtocolError, nothing was thrown");
}

describe("canonicalize — byte-exact reference strings (spec § Signed payload)", () => {
  it("produces the normative GET example from spec/0.1/canonical-payload.md", () => {
    expect(canonicalize(basePayload)).toBe(
      "verus-prepaid-sig/0.1\n" +
        "canonicalDomain: explorer.example.com\n" +
        "method: GET\n" +
        "path: /api/tx/abc\n" +
        "scheme: verus-prepaid-sig\n" +
        "network: vrsctest\n" +
        "asset: VRSCTEST\n" +
        "amount: 0.001\n" +
        "payer: v402test.demoAgent@\n" +
        "payTo: explorerAPI@\n" +
        "requestId: 01H8XG7Q4M2N8P5R7T3V9WXYZA\n" +
        "issuedAt: 1783650000",
    );
  });

  it("produces the normative extension example from spec/0.1/canonical-payload.md", () => {
    const result = canonicalize({
      ...basePayload,
      canonicalDomain: "example.com",
      method: "POST",
      path: "/api/upload",
      amount: "0.005",
      extensions: [
        // deliberately unsorted input — canonicalize must sort
        { key: "x-mystartup.orderId", value: "ord_12345" },
        { key: "scheme.bodyHash", value: "sha256:a1b2c3d4e5f6" },
      ],
    });
    expect(result).toBe(
      "verus-prepaid-sig/0.1\n" +
        "canonicalDomain: example.com\n" +
        "method: POST\n" +
        "path: /api/upload\n" +
        "scheme: verus-prepaid-sig\n" +
        "network: vrsctest\n" +
        "asset: VRSCTEST\n" +
        "amount: 0.005\n" +
        "payer: v402test.demoAgent@\n" +
        "payTo: explorerAPI@\n" +
        "requestId: 01H8XG7Q4M2N8P5R7T3V9WXYZA\n" +
        "issuedAt: 1783650000\n" +
        "scheme.bodyHash: sha256:a1b2c3d4e5f6\n" +
        "x-mystartup.orderId: ord_12345",
    );
  });

  it("has no trailing newline, LF separators only", () => {
    const result = canonicalize(basePayload);
    expect(result.endsWith("\n")).toBe(false);
    expect(result).not.toContain("\r");
  });

  it("treats an empty extensions array like no extensions", () => {
    expect(canonicalize({ ...basePayload, extensions: [] })).toBe(canonicalize(basePayload));
  });

  it("signs the path verbatim including the query string (M1)", () => {
    const result = canonicalize({ ...basePayload, path: "/api/search?q=foo%20bar&limit=10" });
    expect(result).toContain("path: /api/search?q=foo%20bar&limit=10\n");
  });

  it("allows dot-segments inside the query string (only the path part is checked)", () => {
    expect(() => canonicalize({ ...basePayload, path: "/api/search?redirect=/../x" })).not.toThrow();
  });

  it("accepts unicode identities", () => {
    expect(canonicalize({ ...basePayload, payer: "v402.日本語@" })).toContain("payer: v402.日本語@");
  });
});

describe("canonicalize — fail-closed validation", () => {
  const cases: Array<[string, Partial<CanonicalPayload>]> = [
    ["lowercase method", { method: "get" }],
    ["path without leading slash", { path: "api/tx/abc" }],
    ["path with space", { path: "/api/tx/a b" }],
    ["path with dot-segment", { path: "/api/../secret" }],
    ["path with duplicate slashes", { path: "/api//tx" }],
    ["path with newline", { path: "/api\nx" }],
    ["amount with leading zeros", { amount: "00.1" }],
    ["amount in scientific notation", { amount: "1e5" }],
    ["negative amount", { amount: "-1" }],
    ["amount without integer part", { amount: ".5" }],
    ["amount with 9 decimals", { amount: "0.000000001" }],
    ["payer without trailing @", { payer: "v402test.demoAgent" }],
    ["payer with space", { payer: "demo agent@" }],
    ["payTo empty", { payTo: "" }],
    ["requestId too short", { requestId: REQUEST_ID.slice(0, 25) }],
    ["requestId with excluded char I", { requestId: "01H8XG7Q4M2N8P5R7T3V9WXYZI" }],
    ["requestId lowercase", { requestId: REQUEST_ID.toLowerCase() }],
    ["fractional issuedAt", { issuedAt: 1.5 }],
    ["negative issuedAt", { issuedAt: -1 }],
    ["canonicalDomain with space", { canonicalDomain: "example .com" }],
    ["scheme with uppercase", { scheme: "Verus-Prepaid-Sig" }],
    ["schemeVersion without minor", { schemeVersion: "1" }],
    ["network with uppercase", { network: "VRSCTEST" }],
  ];

  it.each(cases)("rejects %s", (_name, overrides) => {
    expect(errorCode(() => canonicalize({ ...basePayload, ...overrides }))).toBe("invalid-field");
  });

  it("rejects trailing-zero amounts only when they exceed 8 decimals", () => {
    expect(canonicalize({ ...basePayload, amount: "1.99999000" })).toContain("amount: 1.99999000");
  });
});

describe("canonicalizeBalanceQuery", () => {
  it("produces the normative balance-query example from spec/0.1/canonical-payload.md", () => {
    expect(
      canonicalizeBalanceQuery({
        canonicalDomain: "facilitator.example.com",
        network: "vrsctest",
        payer: "v402.demoAgent@",
        requestId: "01H8XGABCDEF0123456789QRST",
        issuedAt: 1783650000,
      }),
    ).toBe(
      "v402-balance-query/0.1\n" +
        "canonicalDomain: facilitator.example.com\n" +
        "network: vrsctest\n" +
        "payer: v402.demoAgent@\n" +
        "requestId: 01H8XGABCDEF0123456789QRST\n" +
        "issuedAt: 1783650000",
    );
  });

  it("is domain-separated from payment payloads via line 1", () => {
    const balance = canonicalizeBalanceQuery({
      canonicalDomain: basePayload.canonicalDomain,
      network: basePayload.network,
      payer: basePayload.payer,
      requestId: basePayload.requestId,
      issuedAt: basePayload.issuedAt,
    });
    expect(balance.split("\n")[0]).not.toBe(canonicalize(basePayload).split("\n")[0]);
  });
});

describe("isValidUlid", () => {
  it("accepts the reference ULIDs", () => {
    expect(isValidUlid(REQUEST_ID)).toBe(true);
    expect(isValidUlid("01H8XGABCDEF0123456789QRST")).toBe(true);
  });

  it("rejects a first char above 7 (would exceed 128 bit)", () => {
    expect(isValidUlid("8" + REQUEST_ID.slice(1))).toBe(false);
  });
});
