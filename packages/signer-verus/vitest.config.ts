import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    name: "signer-verus",
    include: ["test/**/*.test.ts"],
  },
});
