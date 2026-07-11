import {
  SPEC_VERSION,
  VECTOR_CATEGORIES,
  loadTestKeys,
  loadVectors,
  type VectorCategory,
  type VectorTestCase,
} from "@chainvue/v402-test-vectors";
import type {
  CaseResult,
  CategoryResult,
  ConformanceReport,
  ConformanceTarget,
  PinnedIdentity,
  WireFormatType,
} from "./types.js";

/**
 * Chain i-addresses by network name — the identity digest binds the chain,
 * so identity-signature cases need it. Only networks that appear in the
 * published vectors are pinned.
 */
const SYSTEM_IDS: Record<string, string> = {
  vrsctest: "iJhCezBExJHvtyH3fGhNnt2NhU4Ztkf2yq",
};

export interface RunConformanceOptions {
  specVersion?: string;
  /** Subset of categories to run. Default: all. */
  categories?: VectorCategory[];
}

/** Drive a target through the reference vectors and report per-case results. */
export async function runConformance(
  target: ConformanceTarget,
  options: RunConformanceOptions = {},
): Promise<ConformanceReport> {
  const specVersion = options.specVersion ?? SPEC_VERSION;
  const categories = options.categories ?? [...VECTOR_CATEGORIES];
  const identity = pinnedIdentity(specVersion);

  const results: CategoryResult[] = [];
  for (const category of categories) {
    const { cases } = loadVectors(category, specVersion);
    const caseResults: CaseResult[] = [];
    for (const testCase of cases) {
      caseResults.push(await runCase(target, category, testCase, identity));
    }
    const status = caseResults.some((c) => c.status === "fail")
      ? "fail"
      : caseResults.every((c) => c.status === "skip")
        ? "skip"
        : "pass";
    results.push({ category, status, cases: caseResults });
  }

  const flat = results.flatMap((c) => c.cases);
  const summary = {
    pass: flat.filter((c) => c.status === "pass").length,
    fail: flat.filter((c) => c.status === "fail").length,
    skip: flat.filter((c) => c.status === "skip").length,
  };
  return { target: target.name, specVersion, ok: summary.fail === 0, categories: results, summary };
}

/** Render a report as a compact human-readable text block. */
export function formatReport(report: ConformanceReport): string {
  const lines = [`v402 conformance — target "${report.target}", spec ${report.specVersion}`];
  for (const category of report.categories) {
    const counts = `${category.cases.filter((c) => c.status === "pass").length}/${category.cases.length}`;
    lines.push(`  [${category.status.toUpperCase().padEnd(4)}] ${category.category} (${counts})`);
    for (const c of category.cases) {
      if (c.status !== "pass") lines.push(`      ${c.status}: ${c.name}${c.detail !== undefined ? ` — ${c.detail}` : ""}`);
    }
  }
  lines.push(
    report.ok
      ? `RESULT: PASS (${report.summary.pass} passed, ${report.summary.skip} skipped)`
      : `RESULT: FAIL (${report.summary.fail} failed, ${report.summary.pass} passed, ${report.summary.skip} skipped)`,
  );
  return lines.join("\n");
}

function pinnedIdentity(specVersion: string): PinnedIdentity | undefined {
  const keys = loadTestKeys(specVersion);
  const entry = keys.identities[0] as
    | { name: string; identityaddress?: string; primaryaddress?: string }
    | undefined;
  const systemId = SYSTEM_IDS[keys.network];
  if (entry?.identityaddress === undefined || entry.primaryaddress === undefined || systemId === undefined) {
    return undefined;
  }
  return {
    name: entry.name,
    identityAddress: entry.identityaddress,
    systemId,
    primaryAddresses: [entry.primaryaddress],
    minimumSignatures: 1,
  };
}

async function runCase(
  target: ConformanceTarget,
  category: VectorCategory,
  testCase: VectorTestCase,
  identity: PinnedIdentity | undefined,
): Promise<CaseResult> {
  try {
    switch (category) {
      case "canonical":
        return await canonicalCase(target, testCase);
      case "extensions":
        return await extensionsCase(target, testCase);
      case "boundary":
        return await boundaryCase(target, testCase);
      case "wire-format":
        return await wireFormatCase(target, testCase);
      case "signing":
        return await signingCase(target, testCase, identity);
      case "verification":
        return await verificationCase(target, testCase, identity);
    }
  } catch (err) {
    return fail(testCase, `unexpected error: ${(err as Error).message}`);
  }
}

function pass(testCase: VectorTestCase): CaseResult {
  return { name: testCase.name, status: "pass" };
}

function fail(testCase: VectorTestCase, detail: string): CaseResult {
  return { name: testCase.name, status: "fail", detail };
}

function skip(testCase: VectorTestCase, detail: string): CaseResult {
  return { name: testCase.name, status: "skip", detail };
}

/** Run an op that a vector expects to FAIL with a specific error code. */
async function expectErrorCode(run: () => Promise<unknown>, expectedCode: string): Promise<string | undefined> {
  try {
    await run();
  } catch (err) {
    const code = (err as { code?: unknown }).code;
    return code === expectedCode ? undefined : `expected error code ${expectedCode}, got ${String(code ?? (err as Error).message)}`;
  }
  return `expected error code ${expectedCode}, but the operation succeeded`;
}

async function canonicalCase(target: ConformanceTarget, testCase: VectorTestCase): Promise<CaseResult> {
  if (target.canonicalize === undefined) return skip(testCase, "canonicalize not implemented");
  const got = await target.canonicalize(
    testCase.input["payload"] as Record<string, unknown>,
    testCase.input["payloadType"] as "payment" | "balanceQuery",
  );
  return got === testCase.expected["canonical"] ? pass(testCase) : fail(testCase, "canonical string mismatch");
}

async function extensionsCase(target: ConformanceTarget, testCase: VectorTestCase): Promise<CaseResult> {
  const op = testCase.input["op"] as "serialize" | "parse";
  const impl = op === "serialize" ? target.serializeExtensions : target.parseExtensions;
  if (impl === undefined) return skip(testCase, `${op}Extensions not implemented`);
  const run =
    op === "serialize"
      ? async () => target.serializeExtensions!(testCase.input["fields"] as Array<{ key: string; value: string }>)
      : async () => target.parseExtensions!(testCase.input["block"] as string);
  if (typeof testCase.expected["error"] === "string") {
    const problem = await expectErrorCode(run, testCase.expected["error"]);
    return problem === undefined ? pass(testCase) : fail(testCase, problem);
  }
  const got = await run();
  const expected = op === "serialize" ? testCase.expected["block"] : testCase.expected["fields"];
  return deepEqual(got, expected) ? pass(testCase) : fail(testCase, `${op} result mismatch`);
}

async function boundaryCase(target: ConformanceTarget, testCase: VectorTestCase): Promise<CaseResult> {
  switch (testCase.input["op"]) {
    case "canonicalize": {
      if (target.canonicalize === undefined) return skip(testCase, "canonicalize not implemented");
      const problem = await expectErrorCode(
        async () => target.canonicalize!(testCase.input["payload"] as Record<string, unknown>, "payment"),
        testCase.expected["error"] as string,
      );
      return problem === undefined ? pass(testCase) : fail(testCase, problem);
    }
    case "humanToSats": {
      if (target.humanToSats === undefined) return skip(testCase, "humanToSats not implemented");
      const got = await target.humanToSats(testCase.input["human"] as string);
      return got === testCase.expected["sats"] ? pass(testCase) : fail(testCase, `expected ${String(testCase.expected["sats"])}, got ${got}`);
    }
    case "satsToHuman": {
      if (target.satsToHuman === undefined) return skip(testCase, "satsToHuman not implemented");
      const got = await target.satsToHuman(testCase.input["sats"] as string);
      return got === testCase.expected["human"] ? pass(testCase) : fail(testCase, `expected ${String(testCase.expected["human"])}, got ${got}`);
    }
    default:
      return fail(testCase, `unknown boundary op ${String(testCase.input["op"])}`);
  }
}

async function wireFormatCase(target: ConformanceTarget, testCase: VectorTestCase): Promise<CaseResult> {
  if (target.validateWireFormat === undefined) return skip(testCase, "validateWireFormat not implemented");
  const result = await target.validateWireFormat(testCase.input["type"] as WireFormatType, testCase.input["value"]);
  if (result.valid !== testCase.expected["valid"]) {
    return fail(testCase, `expected valid=${String(testCase.expected["valid"])}, got ${String(result.valid)}`);
  }
  if (testCase.expected["claim"] !== undefined && !deepEqual(result.claim, testCase.expected["claim"])) {
    return fail(testCase, "parsed claim mismatch");
  }
  return pass(testCase);
}

/**
 * Signing semantics (vectors README): `signature-equal` documents
 * daemon-regeneration byte-equality; independent implementations assert the
 * message hash plus verify-validity of both the reference signature and
 * their own — verusd's RFC 6979 nonce variant makes byte-equality
 * unattainable for third parties, and verification is recovery-based anyway.
 */
async function signingCase(
  target: ConformanceTarget,
  testCase: VectorTestCase,
  identity: PinnedIdentity | undefined,
): Promise<CaseResult> {
  const message = testCase.input["message"] as string;
  const signer = testCase.input["signer"] as string;
  const wif = testCase.input["wif"] as string | null;
  const checks: string[] = [];

  if (target.messageHash !== undefined) {
    const hash = await target.messageHash(message);
    if (hash !== testCase.expected["hash"]) return fail(testCase, `message hash mismatch: got ${hash}`);
    checks.push("hash");
  }
  if (target.verifyMessage !== undefined) {
    const pinned = signer.endsWith("@") ? identity : undefined;
    if (signer.endsWith("@") && pinned === undefined) return skip(testCase, "no pinned identity state available");
    const referenceOk = await target.verifyMessage(message, testCase.expected["signature"] as string, signer, pinned);
    if (!referenceOk) return fail(testCase, "reference signature did not verify");
    checks.push("reference-verify");
    if (wif !== null && target.signMessage !== undefined) {
      const own = await target.signMessage(message, wif);
      if (!(await target.verifyMessage(message, own, signer, pinned))) {
        return fail(testCase, "own signature did not verify");
      }
      checks.push("own-sign-verify");
    }
  }
  if (checks.length === 0) return skip(testCase, "no signing-related operations implemented");
  return pass(testCase);
}

async function verificationCase(
  target: ConformanceTarget,
  testCase: VectorTestCase,
  identity: PinnedIdentity | undefined,
): Promise<CaseResult> {
  if (target.verifyMessage === undefined) return skip(testCase, "verifyMessage not implemented");
  const signer = testCase.input["signer"] as string;
  const pinned = signer.endsWith("@") ? identity : undefined;
  if (signer.endsWith("@") && pinned === undefined) return skip(testCase, "no pinned identity state available");
  const accepted = await target.verifyMessage(
    testCase.input["message"] as string,
    testCase.input["signature"] as string,
    signer,
    pinned,
  );
  return accepted === testCase.expected["accept"]
    ? pass(testCase)
    : fail(testCase, `expected accept=${String(testCase.expected["accept"])}, got ${String(accepted)}`);
}

function deepEqual(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}
