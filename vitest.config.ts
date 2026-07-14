import { defineConfig } from "vitest/config";

// Workspace-mode test runner: every package/app brings its own
// vitest.config.ts and is picked up via the project globs below.
export default defineConfig({
  test: {
    projects: ["packages/*/vitest.config.ts", "apps/*/vitest.config.ts"],
    passWithNoTests: true,
    coverage: {
      provider: "v8",
      // Product source only — tests, configs, build output, generated
      // migrations and type-only barrels are not the thing under test.
      include: ["packages/*/src/**/*.ts"],
      exclude: ["**/*.d.ts", "**/index.ts", "packages/*/src/**/*.test.ts"],
      reporter: ["text-summary", "html", "lcov"],
      // Floors set a few points below the 2026-07-14 measured coverage
      // (stmts 85.6 / branch 72.2 / funcs 86.3 / lines 88.9) so the gate is
      // stable but still catches a real regression. Ratchet upward over time.
      thresholds: {
        statements: 80,
        branches: 65,
        functions: 80,
        lines: 80,
      },
    },
  },
});
