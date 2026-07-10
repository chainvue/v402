import { defineConfig } from "vitest/config";

// Workspace-mode test runner: every package/app brings its own
// vitest.config.ts and is picked up via the project globs below.
export default defineConfig({
  test: {
    projects: ["packages/*/vitest.config.ts", "apps/*/vitest.config.ts"],
    passWithNoTests: true,
  },
});
