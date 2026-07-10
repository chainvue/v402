import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    name: "verus-rpc",
    include: ["test/**/*.test.ts"],
  },
});
