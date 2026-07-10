/**
 * CI gate (delivery plan step 5): packages/protocol must pass every reference
 * test vector in spec/0.1/test-vectors/. If a vector fails here, either the
 * implementation regressed or the spec changed without regenerating vectors
 * (`pnpm generate:vectors`).
 *
 * Signing/verification vectors are checked structurally + for cross-file
 * consistency; cryptographic verification against verusd happens in the
 * RPC-gated integration suite (Layer 2+).
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  V402ProtocolError,
  canonicalize,
  canonicalizeBalanceQuery,
  discoveryDocumentSchema,
  humanToSats,
  isBase64Signature,
  parseExtensionBlock,
  parsePaymentHeaders,
  payment402ResponseSchema,
  paymentRequirementSchema,
  satsToHuman,
  serializeExtensionBlock,
  type BalanceQueryPayload,
  type CanonicalPayload,
  type ExtensionField,
} from "../src/index.js";

interface TestCase {
  name: string;
  spec: string;
  input: Record<string, unknown>;
  expected: Record<string, unknown>;
}

function load(file: string): TestCase[] {
  const url = new URL(`../../../spec/0.1/test-vectors/${file}`, import.meta.url);
  const doc = JSON.parse(readFileSync(url, "utf8")) as { cases: TestCase[] };
  expect(doc.cases.length).toBeGreaterThan(0);
  return doc.cases;
}

function thrownCode(fn: () => unknown): string {
  try {
    fn();
  } catch (err) {
    if (err instanceof V402ProtocolError) return err.code;
    throw err;
  }
  throw new Error("expected V402ProtocolError, nothing was thrown");
}

describe("canonical.json", () => {
  it.each(load("canonical.json"))("$name", ({ input, expected }) => {
    const canonical =
      input["payloadType"] === "balanceQuery"
        ? canonicalizeBalanceQuery(input["payload"] as BalanceQueryPayload)
        : canonicalize(input["payload"] as CanonicalPayload);
    expect(canonical).toBe(expected["canonical"]);
  });
});

describe("extensions.json", () => {
  it.each(load("extensions.json"))("$name", ({ input, expected }) => {
    const run =
      input["op"] === "serialize"
        ? () => serializeExtensionBlock(input["fields"] as ExtensionField[])
        : () => parseExtensionBlock(input["block"] as string);
    if (typeof expected["error"] === "string") {
      expect(thrownCode(run)).toBe(expected["error"]);
    } else if (input["op"] === "serialize") {
      expect(run()).toBe(expected["block"]);
    } else {
      expect(run()).toEqual(expected["fields"]);
    }
  });
});

describe("boundary.json", () => {
  it.each(load("boundary.json"))("$name", ({ input, expected }) => {
    switch (input["op"]) {
      case "canonicalize":
        expect(thrownCode(() => canonicalize(input["payload"] as CanonicalPayload))).toBe(expected["error"]);
        break;
      case "humanToSats":
        expect(humanToSats(input["human"] as string).toString()).toBe(expected["sats"]);
        break;
      case "satsToHuman":
        expect(satsToHuman(BigInt(input["sats"] as string))).toBe(expected["human"]);
        break;
      default:
        throw new Error(`unknown boundary op: ${String(input["op"])}`);
    }
  });
});

describe("wire-format.json", () => {
  it.each(load("wire-format.json"))("$name", ({ input, expected }) => {
    const value = input["value"];
    switch (input["type"]) {
      case "payment402":
        expect(payment402ResponseSchema.safeParse(value).success).toBe(expected["valid"]);
        break;
      case "paymentRequirement":
        expect(paymentRequirementSchema.safeParse(value).success).toBe(expected["valid"]);
        break;
      case "discovery":
        expect(discoveryDocumentSchema.safeParse(value).success).toBe(expected["valid"]);
        break;
      case "paymentHeaders": {
        const result = parsePaymentHeaders(value as Record<string, string | string[] | undefined>);
        expect(result.ok).toBe(expected["valid"]);
        if (result.ok && expected["claim"] !== undefined) {
          expect(result.claim).toEqual(expected["claim"]);
        }
        break;
      }
      default:
        throw new Error(`unknown wire-format type: ${String(input["type"])}`);
    }
  });
});

describe("signing.json (structural — crypto runs in the RPC integration suite)", () => {
  const canonicalByName = new Map(load("canonical.json").map((c) => [c.name, c.expected["canonical"] as string]));

  it.each(load("signing.json"))("$name", ({ input, expected }) => {
    // the frozen message must be exactly the canonical string of the referenced payload
    expect(input["message"]).toBe(canonicalByName.get(input["messageRef"] as string));
    expect(isBase64Signature(expected["signature"] as string)).toBe(true);
    expect(expected["hash"]).toMatch(/^[0-9a-f]{64}$/);
    expect(["signature-equal", "verify-only"]).toContain(expected["assert"]);
    // identity signers have no WIF and must be verify-only (height-embedded signatures)
    if (input["wif"] === null) expect(expected["assert"]).toBe("verify-only");
  });
});

describe("verification.json (structural — crypto runs in the RPC integration suite)", () => {
  it.each(load("verification.json"))("$name", ({ input, expected }) => {
    expect(typeof expected["accept"]).toBe("boolean");
    if (expected["accept"] === true) {
      expect(isBase64Signature(input["signature"] as string)).toBe(true);
    }
    if (expected["reason"] === "malformed-signature-encoding") {
      expect(isBase64Signature(input["signature"] as string)).toBe(false);
    }
  });
});
