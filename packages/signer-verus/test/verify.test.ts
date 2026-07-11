import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  parseIdentitySignature,
  signAddressMessage,
  signIdentityMessage,
  verifyAddressSignature,
  verifyIdentitySignature,
  wrapIdentitySignature,
  type IdentityState,
} from "../src/index.js";
import { decodeWif } from "../src/wif.js";

interface VerificationCase {
  name: string;
  input: { signer: string; signature: string; message: string };
  expected: { accept: boolean };
}

function loadVerificationVectors(): VerificationCase[] {
  const url = new URL("../../../spec/0.1/test-vectors/verification.json", import.meta.url);
  return (JSON.parse(readFileSync(url, "utf8")) as { cases: VerificationCase[] }).cases;
}

// Documented chain facts (see spec/0.1/test-vectors and docs/RISKS.md D2):
// v402test@ has exactly the published test key A as its only primary address.
const VRSCTEST_SYSTEM_ID = "iJhCezBExJHvtyH3fGhNnt2NhU4Ztkf2yq";
const V402TEST: IdentityState = {
  identityAddress: "iGnQaDzEcrFWg3J9Jg5MqPKCwo52Din4Ma",
  primaryAddresses: ["RXzn488JQaeEpo7iezaKiK1XLfRQzi2NWT"],
  minimumSignatures: 1,
};
const KEY_A_WIF = "Uw81VDAH8zrvbGJLfo1nfLaWN9tnGMo2U3bB81Zg8MKBvakrNXqP";

describe("offline verification — daemon-confirmed reference vectors", () => {
  const cases = loadVerificationVectors();
  const address = cases.filter((c) => !c.input.signer.endsWith("@"));
  const identity = cases.filter((c) => c.input.signer.endsWith("@"));

  it("covers both signer kinds", () => {
    expect(address.length).toBeGreaterThanOrEqual(3);
    expect(identity.length).toBeGreaterThanOrEqual(1);
  });

  it.each(address.map((c) => [c.name, c] as const))("address vector %s", (_name, testCase) => {
    expect(verifyAddressSignature(testCase.input.message, testCase.input.signature, testCase.input.signer)).toBe(
      testCase.expected.accept,
    );
  });

  it.each(identity.map((c) => [c.name, c] as const))("identity vector %s", (_name, testCase) => {
    expect(testCase.input.signer).toBe("v402test@");
    const result = verifyIdentitySignature(testCase.input.message, testCase.input.signature, VRSCTEST_SYSTEM_ID, V402TEST);
    expect(result.valid).toBe(testCase.expected.accept);
    if (testCase.expected.accept) expect(result.matchedAddresses).toEqual(V402TEST.primaryAddresses);
  });
});

describe("offline verification — round-trip with our own signer", () => {
  const privateKey = decodeWif(KEY_A_WIF);
  const message = "offline verify round-trip probe";

  it("accepts a locally built address signature and rejects tampering", () => {
    const signature = signAddressMessage(message, privateKey);
    expect(verifyAddressSignature(message, signature, "RXzn488JQaeEpo7iezaKiK1XLfRQzi2NWT")).toBe(true);
    expect(verifyAddressSignature(message + "x", signature, "RXzn488JQaeEpo7iezaKiK1XLfRQzi2NWT")).toBe(false);
    expect(verifyAddressSignature(message, signature, "RLjrXPziU4Moc13vc2vGMvNpMmfM7ozZir")).toBe(false);
  });

  it("accepts a locally built identity signature with matching state", () => {
    const signature = signIdentityMessage(message, privateKey, {
      blockHeight: 1141245,
      systemId: VRSCTEST_SYSTEM_ID,
      identityAddress: V402TEST.identityAddress,
    });
    const result = verifyIdentitySignature(message, signature, VRSCTEST_SYSTEM_ID, V402TEST);
    expect(result.valid).toBe(true);
    expect(result.blockHeight).toBe(1141245);
  });

  it("fails closed on revoked identities and insufficient signatures", () => {
    const signature = signIdentityMessage(message, privateKey, {
      blockHeight: 1141245,
      systemId: VRSCTEST_SYSTEM_ID,
      identityAddress: V402TEST.identityAddress,
    });
    expect(verifyIdentitySignature(message, signature, VRSCTEST_SYSTEM_ID, { ...V402TEST, revoked: true }).valid).toBe(false);
    // 2-of-2 policy with only one signature present
    const multisig = {
      ...V402TEST,
      primaryAddresses: [...V402TEST.primaryAddresses, "RLjrXPziU4Moc13vc2vGMvNpMmfM7ozZir"],
      minimumSignatures: 2,
    };
    const result = verifyIdentitySignature(message, signature, VRSCTEST_SYSTEM_ID, multisig);
    expect(result.valid).toBe(false);
    expect(result.matchedAddresses).toEqual(V402TEST.primaryAddresses);
  });

  it("rejects a signature whose state rotated away from the signing key", () => {
    const signature = signIdentityMessage(message, privateKey, {
      blockHeight: 1141245,
      systemId: VRSCTEST_SYSTEM_ID,
      identityAddress: V402TEST.identityAddress,
    });
    const rotated = { ...V402TEST, primaryAddresses: ["RLjrXPziU4Moc13vc2vGMvNpMmfM7ozZir"] };
    expect(verifyIdentitySignature(message, signature, VRSCTEST_SYSTEM_ID, rotated).valid).toBe(false);
  });
});

describe("parseIdentitySignature", () => {
  it("round-trips the envelope our signer builds", () => {
    const compact = Buffer.alloc(65, 7).toString("base64");
    const parsed = parseIdentitySignature(wrapIdentitySignature(compact, 123456));
    expect(parsed.version).toBe(1);
    expect(parsed.blockHeight).toBe(123456);
    expect(parsed.signatures).toHaveLength(1);
    expect(Buffer.from(parsed.signatures[0]!).toString("base64")).toBe(compact);
  });

  it.each([
    ["empty", ""],
    ["not base64 / too short", "x"],
    ["wrong version", Buffer.from([0x02, 0, 0, 0, 1, 1, 0x41, ...Buffer.alloc(65)]).toString("base64")],
    ["zero signatures", Buffer.from([0x01, 0, 0, 0, 1, 0]).toString("base64")],
    ["truncated signature", Buffer.from([0x01, 0, 0, 0, 1, 1, 0x41, ...Buffer.alloc(10)]).toString("base64")],
    ["trailing bytes", Buffer.from([0x01, 0, 0, 0, 1, 1, 0x41, ...Buffer.alloc(66)]).toString("base64")],
  ])("throws on %s", (_name, envelope) => {
    expect(() => parseIdentitySignature(envelope)).toThrow();
  });

  it("verifies as invalid (not throwing) through verifyIdentitySignature", () => {
    const result = verifyIdentitySignature("m", "AAAA", VRSCTEST_SYSTEM_ID, V402TEST);
    expect(result.valid).toBe(false);
    expect(result.reason).toContain("malformed envelope");
  });
});
