/**
 * Typed loader for the v402 reference test vectors. The JSON files under
 * `vectors/<specVersion>/` are the actual product — implementations in other
 * languages consume them directly from the npm tarball or the spec repo
 * (source of truth: `spec/0.1/test-vectors/`).
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

export const SPEC_VERSION = "0.1";

export const VECTOR_CATEGORIES = [
  "canonical",
  "extensions",
  "boundary",
  "wire-format",
  "signing",
  "verification",
] as const;

export type VectorCategory = (typeof VECTOR_CATEGORIES)[number];

export interface VectorTestCase {
  name: string;
  spec: string;
  input: Record<string, unknown>;
  expected: Record<string, unknown>;
}

export interface VectorFile {
  category: string;
  generator: string;
  cases: VectorTestCase[];
  /** Category-specific metadata (network, daemon, notes, …). */
  [key: string]: unknown;
}

export interface TestKeys {
  comment: string;
  derivation: string;
  network: string;
  keys: Array<{ id: string; seed: string; wif: string; address: string }>;
  identities: Array<{ name: string; note: string }>;
}

/** Absolute path of a vector file — for consumers that want the raw JSON. */
export function vectorFilePath(name: string, specVersion: string = SPEC_VERSION): string {
  return fileURLToPath(new URL(`../vectors/${specVersion}/${name}.json`, import.meta.url));
}

export function loadVectors(category: VectorCategory, specVersion: string = SPEC_VERSION): VectorFile {
  const file = JSON.parse(readFileSync(vectorFilePath(category, specVersion), "utf8")) as VectorFile;
  if (!Array.isArray(file.cases) || file.cases.length === 0) {
    throw new Error(`vector file ${category}.json has no cases`);
  }
  return file;
}

/** The published test keys (deliberately public — see keys.json / README). */
export function loadTestKeys(specVersion: string = SPEC_VERSION): TestKeys {
  return JSON.parse(readFileSync(vectorFilePath("keys", specVersion), "utf8")) as TestKeys;
}
