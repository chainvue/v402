import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { VECTOR_CATEGORIES, loadTestKeys, loadVectors, vectorFilePath } from "../src/index.js";

/**
 * The committed copy under vectors/0.1/ must stay byte-identical to the
 * source of truth in spec/0.1/test-vectors/. On failure run:
 * pnpm --filter @chainvue/v402-test-vectors sync
 */
describe("parity with spec/0.1/test-vectors", () => {
  const specFile = (name: string): string =>
    readFileSync(new URL(`../../../spec/0.1/test-vectors/${name}.json`, import.meta.url), "utf8");

  it.each([...VECTOR_CATEGORIES, "keys"] as const)("%s.json is in sync", (name) => {
    expect(readFileSync(vectorFilePath(name), "utf8")).toBe(specFile(name));
  });
});

describe("loaders", () => {
  it.each(VECTOR_CATEGORIES)("loadVectors(%j) returns cases with the required shape", (category) => {
    const file = loadVectors(category);
    expect(file.cases.length).toBeGreaterThan(0);
    for (const testCase of file.cases) {
      expect(testCase.name).toBeTruthy();
      expect(testCase.spec).toBe("verus-prepaid-sig-v0.1");
      expect(testCase.input).toBeTypeOf("object");
      expect(testCase.expected).toBeTypeOf("object");
    }
  });

  it("loadTestKeys returns both published keys", () => {
    const keys = loadTestKeys();
    expect(keys.keys.map((k) => k.id)).toEqual(["A", "B"]);
    expect(keys.network).toBe("vrsctest");
  });
});
