import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    name: "storage-sqlite",
    include: ["test/**/*.test.ts"],
  },
});
