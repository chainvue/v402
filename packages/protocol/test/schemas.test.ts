import { describe, expect, it } from "vitest";
import {
  discoveryDocumentSchema,
  parsePaymentHeaders,
  payment402ResponseSchema,
  paymentRequirementSchema,
} from "../src/index.js";

/** The normative 402 example from spec/0.1/protocol.md § 3. */
const accepts402 = {
  scheme: "verus-prepaid-sig",
  schemeVersion: "0.1",
  network: "vrsctest",
  asset: "VRSCTEST",
  amount: "0.001",
  amountUnit: "human",
  payTo: "explorerAPI@",
  facilitator: "https://facilitator.local/v1",
  requiredHeaders: [
    "X-V402-Scheme",
    "X-V402-Payer",
    "X-V402-Amount",
    "X-V402-Request-Id",
    "X-V402-Issued-At",
    "X-V402-Signature",
  ],
  canonicalDomain: "explorer.example.com",
  topup: {
    depositAddress: "explorerAPI@",
    attribution: "sender-verusid",
  },
};

describe("payment402ResponseSchema", () => {
  it("parses the normative 402 example", () => {
    const result = payment402ResponseSchema.safeParse({ version: "v402/0.1", accepts: [accepts402] });
    expect(result.success).toBe(true);
  });

  it("tolerates accepts entries of unknown schemes (forward compatibility)", () => {
    const result = payment402ResponseSchema.safeParse({
      version: "v402/0.1",
      accepts: [accepts402, { scheme: "evm-eip3009", schemeVersion: "1.0", someEvmField: true }],
    });
    expect(result.success).toBe(true);
  });

  it("rejects a response without version", () => {
    expect(payment402ResponseSchema.safeParse({ accepts: [] }).success).toBe(false);
  });
});

describe("paymentRequirementSchema", () => {
  it("fully validates the picked accepts entry", () => {
    expect(paymentRequirementSchema.safeParse(accepts402).success).toBe(true);
  });

  it("keeps unknown optional fields (MINOR additions must survive parsing)", () => {
    const result = paymentRequirementSchema.safeParse({ ...accepts402, futureField: "x" });
    expect(result.success).toBe(true);
    expect(result.success && (result.data as Record<string, unknown>)["futureField"]).toBe("x");
  });

  it.each([
    ["bad amountUnit", { amountUnit: "sats" }],
    ["bad amount", { amount: "0,001" }],
    ["payTo without @", { payTo: "explorerAPI" }],
    ["empty requiredHeaders", { requiredHeaders: [] }],
    ["bad schemeVersion", { schemeVersion: "v1" }],
  ])("rejects %s", (_name, overrides) => {
    expect(paymentRequirementSchema.safeParse({ ...accepts402, ...overrides }).success).toBe(false);
  });
});

describe("discoveryDocumentSchema", () => {
  it("parses the normative discovery example", () => {
    const result = discoveryDocumentSchema.safeParse({
      specUrl: "https://v402.dev/spec/",
      supportedVersions: ["v402/0.1"],
      defaultVersion: "v402/0.1",
      deprecatedVersions: [],
      sunsetDates: {},
      supportedExtensions: ["scheme.bodyHash"],
    });
    expect(result.success).toBe(true);
  });

  it("rejects a document without supportedVersions", () => {
    expect(discoveryDocumentSchema.safeParse({ defaultVersion: "v402/0.1" }).success).toBe(false);
  });
});

describe("parsePaymentHeaders", () => {
  // node-style lowercased incoming headers
  const validHeaders = {
    "x-v402-scheme": "verus-prepaid-sig",
    "x-v402-payer": "v402test.demoAgent@",
    "x-v402-amount": "0.001",
    "x-v402-request-id": "01H8XG7Q4M2N8P5R7T3V9WXYZA",
    "x-v402-issued-at": "1783650000",
    "x-v402-signature": "AgQ2Zml0eXNpZ25hdHVyZQ==",
  };

  it("parses valid headers into a PaymentClaim", () => {
    const result = parsePaymentHeaders(validHeaders);
    expect(result).toEqual({
      ok: true,
      claim: {
        scheme: "verus-prepaid-sig",
        payer: "v402test.demoAgent@",
        amount: "0.001",
        requestId: "01H8XG7Q4M2N8P5R7T3V9WXYZA",
        issuedAt: 1783650000,
        signature: "AgQ2Zml0eXNpZ25hdHVyZQ==",
      },
    });
  });

  it("passes the optional extensions header through untouched", () => {
    const result = parsePaymentHeaders({ ...validHeaders, "x-v402-extensions": "c2NoZW1lLmJvZHlIYXNoOiB4" });
    expect(result.ok && result.claim.extensionsRaw).toBe("c2NoZW1lLmJvZHlIYXNoOiB4");
  });

  it("is case-insensitive on header names", () => {
    const result = parsePaymentHeaders({
      "X-V402-Scheme": validHeaders["x-v402-scheme"],
      "X-V402-Payer": validHeaders["x-v402-payer"],
      "X-V402-Amount": validHeaders["x-v402-amount"],
      "X-V402-Request-Id": validHeaders["x-v402-request-id"],
      "X-V402-Issued-At": validHeaders["x-v402-issued-at"],
      "X-V402-Signature": validHeaders["x-v402-signature"],
    });
    expect(result.ok).toBe(true);
  });

  it.each([
    ["missing signature", { "x-v402-signature": undefined }],
    ["repeated header", { "x-v402-payer": ["a@", "b@"] }],
    ["payer without @", { "x-v402-payer": "demoAgent" }],
    ["bad amount", { "x-v402-amount": "0,001" }],
    ["bad requestId", { "x-v402-request-id": "not-a-ulid" }],
    ["fractional issuedAt", { "x-v402-issued-at": "12.5" }],
    ["negative issuedAt", { "x-v402-issued-at": "-1" }],
    ["base64url signature", { "x-v402-signature": "AgQ2-_l0eXNpZ25hdHVyZQ==" }],
  ])("fails closed on %s", (_name, overrides) => {
    const result = parsePaymentHeaders({ ...validHeaders, ...overrides } as Record<
      string,
      string | string[] | undefined
    >);
    expect(result.ok).toBe(false);
  });
});
