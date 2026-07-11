#!/usr/bin/env node
/**
 * v402-conformance — run the v402 reference vectors against ANY
 * implementation via the subprocess protocol (see subprocess.ts for the
 * NDJSON wire format).
 *
 *   v402-conformance [options] [--] <command> [args…]
 *
 *   --categories <a,b,…>   subset of vector categories (default: all)
 *   --spec-version <v>     vector set version (default: current)
 *   --timeout <ms>         per-operation timeout (default: 10000)
 *   --strict               skips count as failure (full-conformance gate)
 *
 * Exit codes: 0 conformant · 1 failed cases (or skips with --strict) ·
 * 2 usage or transport error.
 */
import { VECTOR_CATEGORIES, type VectorCategory } from "@chainvue/v402-test-vectors";
import { formatReport } from "./runner.js";
import { runConformance } from "./runner.js";
import { subprocessTarget } from "./subprocess.js";

const USAGE = `Usage: v402-conformance [options] [--] <command> [args…]

Options:
  --categories <a,b,…>   subset of ${VECTOR_CATEGORIES.join(", ")}
  --spec-version <v>     vector set version (default: current)
  --timeout <ms>         per-operation timeout (default: 10000)
  --strict               skips count as failure (full-conformance gate)

The command is spawned once and driven over the NDJSON stdin/stdout protocol
documented in the @chainvue/v402-conformance-suite README.`;

interface CliOptions {
  categories?: VectorCategory[];
  specVersion?: string;
  timeoutMs?: number;
  strict: boolean;
  command: string;
  commandArgs: string[];
}

function fail(message: string): never {
  process.stderr.write(`${message}\n\n${USAGE}\n`);
  process.exit(2);
}

function parseArgs(argv: string[]): CliOptions {
  const options: CliOptions = { strict: false, command: "", commandArgs: [] };
  let i = 0;
  for (; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === "--") {
      i++;
      break;
    }
    if (!arg.startsWith("--")) break; // first non-flag token starts the command
    if (arg === "--strict") {
      options.strict = true;
      continue;
    }
    const value = argv[++i];
    if (value === undefined) fail(`missing value for ${arg}`);
    if (arg === "--categories") {
      const categories = value.split(",").map((c) => c.trim());
      const unknown = categories.filter((c) => !(VECTOR_CATEGORIES as readonly string[]).includes(c));
      if (unknown.length > 0) fail(`unknown categories: ${unknown.join(", ")}`);
      options.categories = categories as VectorCategory[];
    } else if (arg === "--spec-version") {
      options.specVersion = value;
    } else if (arg === "--timeout") {
      const ms = Number(value);
      if (!Number.isInteger(ms) || ms <= 0) fail(`--timeout must be a positive integer, got ${value}`);
      options.timeoutMs = ms;
    } else {
      fail(`unknown option ${arg}`);
    }
  }
  const command = argv[i];
  if (command === undefined) fail("no implementation command given");
  options.command = command;
  options.commandArgs = argv.slice(i + 1);
  return options;
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));

  const { target, declaredOps, close } = await subprocessTarget({
    command: options.command,
    args: options.commandArgs,
    ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
  });
  process.stderr.write(`target "${target.name}" declared ops: ${declaredOps.join(", ") || "(none)"}\n`);

  try {
    const report = await runConformance(target, {
      ...(options.categories !== undefined ? { categories: options.categories } : {}),
      ...(options.specVersion !== undefined ? { specVersion: options.specVersion } : {}),
    });
    process.stdout.write(formatReport(report) + "\n");
    if (!report.ok) process.exitCode = 1;
    else if (options.strict && report.summary.skip > 0) {
      process.stdout.write(`STRICT: ${report.summary.skip} skipped case(s) count as failure\n`);
      process.exitCode = 1;
    }
  } finally {
    await close();
  }
}

main().catch((err: unknown) => {
  process.stderr.write(`v402-conformance: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(2);
});
