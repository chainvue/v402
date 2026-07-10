// Copies the normative vectors from spec/0.1/test-vectors/ (source of truth)
// into this package's vectors/0.1/. The copy is committed; the parity test
// fails when it drifts from the spec — fix by running `pnpm --filter
// @chainvue/v402-test-vectors sync` (also runs as part of build/prepack).
import { copyFileSync, mkdirSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const specDir = join(packageRoot, "..", "..", "spec", "0.1", "test-vectors");
const outDir = join(packageRoot, "vectors", "0.1");

mkdirSync(outDir, { recursive: true });
const files = readdirSync(specDir).filter((f) => f.endsWith(".json"));
if (files.length === 0) throw new Error(`no vector JSON files found in ${specDir}`);
for (const file of files) {
  copyFileSync(join(specDir, file), join(outDir, file));
}
console.log(`synced ${files.length} vector files from spec/0.1/test-vectors/`);
