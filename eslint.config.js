// Workspace-wide ESLint flat config (single config, no per-package configs).
//
// Two tiers:
// - Package/app sources and tests get TYPE-CHECKED linting (projectService
//   resolves each file's tsconfig) — this is where rules like
//   no-floating-promises earn their keep.
// - Standalone scripts and config files (run via Node type stripping, not
//   covered by any tsconfig) get the syntactic recommended set only.
import js from "@eslint/js";
import globals from "globals";
import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    ignores: ["**/dist/", "**/node_modules/", "packages/test-vectors/vectors/"],
  },
  {
    files: ["**/*.ts", "**/*.js", "**/*.mjs"],
    ...js.configs.recommended,
    languageOptions: { globals: globals.node },
  },
  // Type-checked tier: everything a package tsconfig covers.
  ...tseslint.configs.recommendedTypeChecked.map((config) => ({
    ...config,
    files: ["packages/*/src/**/*.ts", "packages/*/test/**/*.ts", "apps/*/src/**/*.ts", "apps/*/test/**/*.ts"],
  })),
  {
    files: ["packages/*/src/**/*.ts", "packages/*/test/**/*.ts", "apps/*/src/**/*.ts", "apps/*/test/**/*.ts"],
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
  },
  // Syntactic tier: scripts + root/package config files.
  ...tseslint.configs.recommended.map((config) => ({
    ...config,
    files: ["scripts/**/*.ts", "**/*.config.ts"],
  })),
  {
    files: ["packages/*/src/**/*.ts", "packages/*/test/**/*.ts", "apps/*/src/**/*.ts", "apps/*/test/**/*.ts"],
    rules: {
      // The storage/watcher layers implement async interfaces over synchronous
      // backends (better-sqlite3, in-memory maps) — an async method without
      // await is architecture here, not an accident.
      "@typescript-eslint/require-await": "off",
      // Destructure-to-omit and interface-conforming unused params use the _
      // prefix.
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_", caughtErrorsIgnorePattern: "^_" },
      ],
      // Sources use structured loggers (pino / Nest logger); console is only
      // legitimate before a logger can exist (bootstrap catch) — disable inline
      // there with a reason.
      "no-console": "error",
    },
  },
  {
    // The e2e test suites live on supertest, whose response bodies are `any`
    // by design — the unsafe-* family would demand blanket casts for zero
    // safety gain. Sources keep the full rule set.
    files: ["packages/*/test/**/*.ts", "apps/*/test/**/*.ts"],
    rules: {
      "@typescript-eslint/no-unsafe-argument": "off",
      "@typescript-eslint/no-unsafe-assignment": "off",
      "@typescript-eslint/no-unsafe-call": "off",
      "@typescript-eslint/no-unsafe-member-access": "off",
      "@typescript-eslint/no-unsafe-return": "off",
      "@typescript-eslint/unbound-method": "off",
      "@typescript-eslint/no-base-to-string": "off",
      "no-console": "off",
    },
  },
  {
    // Operational tooling: JSON blobs from RPC/HTTP responses; `any` is the
    // honest type at this altitude and console IS the output channel.
    files: ["scripts/**/*.ts", "scripts/**/*.mjs"],
    rules: {
      "@typescript-eslint/no-explicit-any": "off",
    },
  },
);
