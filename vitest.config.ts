import { defineConfig } from "vitest/config";

// Workspace-mode test runner: every package/app brings its own
// vitest.config.ts and is picked up via the project globs below.
export default defineConfig({
  test: {
    projects: [
      "packages/*/vitest.config.ts",
      "apps/*/vitest.config.ts",
      // Vitest errors when the globs above match nothing; this empty root
      // project keeps `pnpm test` green until the first package lands
      // (Etappe 1, Layer 1). Remove it once packages/protocol exists.
      { test: { name: "root", include: [] } },
    ],
    passWithNoTests: true,
  },
});
