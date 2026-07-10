import { defineConfig } from "vitest/config";

// Same rule as the facilitator: esbuild has no decorator metadata,
// so DI in this package always uses explicit @Inject(TOKEN).
export default defineConfig({
  test: {
    name: "adapter-nestjs",
    include: ["test/**/*.test.ts"],
  },
});
