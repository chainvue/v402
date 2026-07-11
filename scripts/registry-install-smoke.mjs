// From-registry install smoke (docs/RISKS.md process rule, Etappe 1.5):
// install every non-private workspace package at its CURRENT workspace
// version from the public npm registry into a fresh throwaway project and
// import it. Run from the repo root (reads packages/*/package.json), but the
// install itself happens in an isolated temp dir so workspace resolution
// cannot mask a broken registry dependency tree — exactly the failure mode
// of the conformance-suite@0.1.0 incident (it imported signer-verus exports
// that the registry's signer-verus@0.1.0 did not have).
//
// Freshly published versions can lag on the registry's read replicas, so the
// install is retried for a few minutes before failing.
import { execFileSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const INSTALL_ATTEMPTS = Number(process.env["SMOKE_INSTALL_ATTEMPTS"] ?? 8);
const RETRY_DELAY_MS = Number(process.env["SMOKE_RETRY_DELAY_MS"] ?? 30_000);

const packagesDir = new URL("../packages/", import.meta.url).pathname;
const targets = readdirSync(packagesDir)
  .map((dir) => {
    try {
      return JSON.parse(readFileSync(join(packagesDir, dir, "package.json"), "utf8"));
    } catch {
      return null;
    }
  })
  .filter((pkg) => pkg && !pkg.private)
  .map((pkg) => ({ name: pkg.name, version: pkg.version }));

if (targets.length === 0) throw new Error("no publishable packages found under packages/");
console.log(`smoke targets: ${targets.map((t) => `${t.name}@${t.version}`).join(", ")}`);

const workDir = mkdtempSync(join(tmpdir(), "v402-registry-smoke-"));
writeFileSync(join(workDir, "package.json"), JSON.stringify({ name: "v402-registry-smoke", private: true, type: "module" }));

const specs = targets.map((t) => `${t.name}@${t.version}`);
let installed = false;
for (let attempt = 1; attempt <= INSTALL_ATTEMPTS && !installed; attempt++) {
  try {
    execFileSync("npm", ["install", "--no-audit", "--no-fund", ...specs], {
      cwd: workDir,
      stdio: "inherit",
      env: { ...process.env, npm_config_registry: "https://registry.npmjs.org/" },
    });
    installed = true;
  } catch (err) {
    if (attempt === INSTALL_ATTEMPTS) throw err;
    console.log(`install attempt ${attempt} failed (registry propagation?) — retrying in ${RETRY_DELAY_MS / 1000}s`);
    await new Promise((resolve) => setTimeout(resolve, RETRY_DELAY_MS));
  }
}

// Import each package from INSIDE the temp project (child process, cwd =
// temp dir) so the specifier resolves through the registry-installed
// node_modules and the package's exports map — never through the workspace.
// Also check the resolved version: a mismatch means npm pulled something
// other than what we just published.
let failures = 0;
for (const { name, version } of targets) {
  const resolved = JSON.parse(readFileSync(join(workDir, "node_modules", name, "package.json"), "utf8"));
  if (resolved.version !== version) {
    console.error(`FAIL ${name}: expected ${version}, registry install resolved ${resolved.version}`);
    failures++;
    continue;
  }
  try {
    // Timeout: a package import must terminate. facilitator@0.1.1 shipped
    // with main pointing at the server bootstrap — importing it started a
    // listening Nest app and hung this smoke forever. Fixed in 0.1.2 (main
    // → dist/index.js); the timeout turns any regression into a loud FAIL.
    execFileSync("node", ["--input-type=module", "-e", `await import(${JSON.stringify(name)});`], {
      cwd: workDir,
      stdio: ["ignore", "inherit", "inherit"],
      timeout: 60_000,
      killSignal: "SIGKILL",
    });
    console.log(`ok   ${name}@${version} (installed + imported)`);
  } catch (err) {
    console.error(`FAIL ${name}@${version}: ${err.signal === "SIGKILL" ? "import did not terminate within 60s (side-effectful entry point?)" : "import threw"}`);
    failures++;
  }
}

if (failures > 0) {
  console.error(`registry install smoke FAILED: ${failures}/${targets.length} packages`);
  process.exit(1);
}
console.log(`registry install smoke PASSED: ${targets.length}/${targets.length} packages`);
