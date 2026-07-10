import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    name: "client-fetch",
    include: ["test/**/*.test.ts"],
    testTimeout: 30_000, // the parallel e2e run does 200 real HTTP roundtrips
  },
});
