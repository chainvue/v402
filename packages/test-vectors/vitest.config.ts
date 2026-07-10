import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    name: "test-vectors",
    include: ["test/**/*.test.ts"],
  },
});
