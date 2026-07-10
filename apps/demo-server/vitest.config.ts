import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    name: "demo-server",
    include: ["test/**/*.test.ts"],
  },
});
