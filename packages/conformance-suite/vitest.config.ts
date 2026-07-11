import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    name: "conformance-suite",
    include: ["test/**/*.test.ts"],
  },
});
