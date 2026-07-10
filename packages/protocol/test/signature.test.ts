import { describe, expect, it } from "vitest";
import { V402ProtocolError, assertBase64Signature, isBase64Signature } from "../src/index.js";

describe("Base64 signature pass-through (Q4)", () => {
  it.each([
    // realistic shape: verus signmessage output is ~88 chars of standard base64
    "AgQ2SGVsbG8rL3dvcmxkSGVsbG8rL3dvcmxkSGVsbG8rL3dvcmxkSGVsbG8rL3dvcmxkSGVsbG8rL3dvcmxkQUJDRA==",
    "SGVsbG8=",
    "SGVsbG9X",
    "SGVsbG8rLw==",
  ])("accepts standard Base64 %#", (value) => {
    expect(isBase64Signature(value)).toBe(true);
    expect(() => assertBase64Signature(value)).not.toThrow();
  });

  it.each([
    "",
    "abc",
    "====",
    "SGVsbG8", // missing padding
    "SGVsbG8-", // base64url alphabet
    "SGVsbG8_",
    "SGVs bG8=",
    "SGVsbG8=\n",
  ])("rejects %j", (value) => {
    expect(isBase64Signature(value)).toBe(false);
    expect(() => assertBase64Signature(value)).toThrowError(V402ProtocolError);
  });
});
