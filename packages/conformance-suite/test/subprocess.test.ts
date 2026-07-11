/**
 * Subprocess transport + CLI: self-conformance through a REAL process
 * boundary. The fixture child serves the reference implementation over the
 * NDJSON protocol — a full run must pass every vector with zero skips,
 * which also proves error-code passthrough (the vectors assert error
 * identifiers) and the identity handoff for verify cases.
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { runConformance, subprocessTarget } from "../src/index.js";

const execFileAsync = promisify(execFile);
const FIXTURE = new URL("./fixtures/reference-child.mjs", import.meta.url).pathname;
const CLI = new URL("../dist/cli.js", import.meta.url).pathname;

describe("subprocess transport", () => {
  it("runs the full vector set through the wire protocol — zero skips", async () => {
    const { target, declaredOps, close } = await subprocessTarget({ command: "node", args: [FIXTURE] });
    try {
      expect(target.name).toBe("reference-child");
      expect(declaredOps).toHaveLength(9);
      const report = await runConformance(target);
      expect(report.ok).toBe(true);
      expect(report.summary.fail).toBe(0);
      expect(report.summary.skip).toBe(0);
      expect(report.summary.pass).toBeGreaterThanOrEqual(70);
    } finally {
      await close();
    }
  });

  it("a partial implementation reports skips, never failures", async () => {
    const restricted = await subprocessTargetWithEnv({ OPS: "canonicalize,humanToSats,satsToHuman" });
    try {
      expect(restricted.declaredOps).toEqual(["canonicalize", "humanToSats", "satsToHuman"]);
      const report = await runConformance(restricted.target);
      expect(report.ok).toBe(true);
      expect(report.summary.skip).toBeGreaterThan(0);
      expect(report.summary.fail).toBe(0);
    } finally {
      await restricted.close();
    }
  });

  it("fails cleanly when the child dies immediately", async () => {
    await expect(subprocessTarget({ command: "node", args: ["-e", "process.exit(1)"], timeoutMs: 3_000 })).rejects.toThrow(
      /child exited|timed out/,
    );
  });

  it("fails cleanly on a child that speaks garbage", async () => {
    await expect(
      subprocessTarget({
        command: "node",
        args: ["-e", 'process.stdin.resume(); console.log("not json"); setTimeout(() => {}, 5000);'],
        timeoutMs: 3_000,
      }),
    ).rejects.toThrow(/non-JSON/);
  });
});

describe("v402-conformance CLI", () => {
  it("exits 0 with a PASS report for the reference child (strict)", async () => {
    const { stdout } = await execFileAsync("node", [CLI, "--strict", "--", "node", FIXTURE]);
    expect(stdout).toContain("RESULT: PASS");
    expect(stdout).not.toContain("skipped, ");
  });

  it("exits 1 under --strict when ops are missing (skips present)", async () => {
    await expect(
      execFileAsync("node", [CLI, "--strict", "--", "node", FIXTURE], {
        env: { ...process.env, OPS: "canonicalize" },
      }),
    ).rejects.toMatchObject({ code: 1 });
  });

  it("exits 2 on usage errors", async () => {
    await expect(execFileAsync("node", [CLI, "--categories", "nope", "--", "node", FIXTURE])).rejects.toMatchObject({ code: 2 });
  });
});

/** Spawn the fixture with an OPS restriction (partial implementation). */
async function subprocessTargetWithEnv(env: Record<string, string>) {
  const previous = new Map<string, string | undefined>();
  for (const [key, value] of Object.entries(env)) {
    previous.set(key, process.env[key]);
    process.env[key] = value;
  }
  try {
    return await subprocessTarget({ command: "node", args: [FIXTURE] });
  } finally {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}
