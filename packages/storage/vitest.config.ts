import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    name: "storage",
    include: ["test/**/*.test.ts"],
  },
});
