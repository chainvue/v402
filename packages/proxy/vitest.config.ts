import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    name: "proxy",
    include: ["test/**/*.test.ts"],
  },
});
