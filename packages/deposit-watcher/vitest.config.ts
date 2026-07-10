import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    name: "deposit-watcher",
    include: ["test/**/*.test.ts"],
  },
});
