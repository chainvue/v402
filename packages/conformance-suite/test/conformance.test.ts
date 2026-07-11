import { describe, expect, it } from "vitest";
import { formatReport, referenceTarget, runConformance, type ConformanceTarget } from "../src/index.js";

describe("self-conformance — the reference implementation passes every vector", () => {
  it("passes all categories with zero skips", async () => {
    const report = await runConformance(referenceTarget());
    const failures = report.categories
      .flatMap((c) => c.cases.filter((x) => x.status !== "pass").map((x) => `${c.category}/${x.name}: ${x.detail ?? x.status}`));
    expect(failures).toEqual([]);
    expect(report.ok).toBe(true);
    expect(report.summary.skip).toBe(0);
    expect(report.summary.pass).toBeGreaterThanOrEqual(70);
  });
});

describe("runner semantics", () => {
  it("reports missing operations as skipped categories, not failures", async () => {
    const partial: ConformanceTarget = {
      name: "canonical-only",
      canonicalize: referenceTarget().canonicalize!,
    };
    const report = await runConformance(partial);
    expect(report.ok).toBe(true); // skips never fail a run
    expect(report.categories.find((c) => c.category === "canonical")?.status).toBe("pass");
    expect(report.categories.find((c) => c.category === "extensions")?.status).toBe("skip");
    expect(report.categories.find((c) => c.category === "verification")?.status).toBe("skip");
    // boundary mixes canonicalize (runnable) with amount ops (skipped)
    expect(report.categories.find((c) => c.category === "boundary")?.status).toBe("pass");
    expect(report.summary.skip).toBeGreaterThan(0);
  });

  it("detects a non-conformant implementation", async () => {
    const broken: ConformanceTarget = {
      ...referenceTarget(),
      name: "broken-canonicalizer",
      canonicalize: () => "not the canonical form",
    };
    const report = await runConformance(broken, { categories: ["canonical"] });
    expect(report.ok).toBe(false);
    expect(report.summary.fail).toBeGreaterThan(0);
    expect(formatReport(report)).toContain("RESULT: FAIL");
  });

  it("detects wrong error codes on reject cases", async () => {
    const wrongCodes: ConformanceTarget = {
      name: "wrong-error-codes",
      canonicalize: () => {
        const err = new Error("nope") as Error & { code: string };
        err.code = "some-other-code";
        throw err;
      },
    };
    const report = await runConformance(wrongCodes, { categories: ["boundary"] });
    const canonicalizeCases = report.categories[0]!.cases.filter((c) => c.status === "fail");
    expect(canonicalizeCases.length).toBeGreaterThan(0);
    expect(canonicalizeCases[0]!.detail).toContain("expected error code");
  });

  it("formats a passing report", async () => {
    const report = await runConformance(referenceTarget(), { categories: ["canonical"] });
    const text = formatReport(report);
    expect(text).toContain("RESULT: PASS");
    expect(text).toContain("canonical");
  });
});
