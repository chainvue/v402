import { describe, expect, it } from "vitest";
import { V402ProtocolError, humanToSats, isValidHumanAmount, satsToHuman } from "../src/index.js";

describe("humanToSats", () => {
  it.each([
    ["0", 0n],
    ["0.001", 100_000n],
    ["1", 100_000_000n],
    ["1.99999000", 199_999_000n],
    ["0.00000001", 1n],
    ["21000000", 2_100_000_000_000_000n],
    ["184467440737.09551616", 18_446_744_073_709_551_616n],
  ])("parses %s → %s sats", (human, sats) => {
    expect(humanToSats(human)).toBe(sats);
  });

  it.each(["", ".", "1.", ".5", "00.1", "01", "0.000000001", "1e5", "-1", "+1", " 1", "1 ", "1,5", "NaN"])(
    "rejects %j",
    (input) => {
      expect(() => humanToSats(input)).toThrowError(V402ProtocolError);
      expect(isValidHumanAmount(input)).toBe(false);
    },
  );
});

describe("satsToHuman", () => {
  it.each([
    [0n, "0"],
    [1n, "0.00000001"],
    [123n, "0.00000123"],
    [100_000n, "0.001"],
    [199_999_000n, "1.99999"],
    [100_000_000n, "1"],
    [2_100_000_000_000_000n, "21000000"],
    [-100_000n, "-0.001"],
  ])("formats %s sats → %s", (sats, human) => {
    expect(satsToHuman(sats)).toBe(human);
  });

  it("round-trips through humanToSats for non-negative values", () => {
    for (const sats of [0n, 1n, 99n, 100_000n, 123_456_789n, 100_000_000n, 18_446_744_073_709_551_616n]) {
      expect(humanToSats(satsToHuman(sats))).toBe(sats);
    }
  });
});
