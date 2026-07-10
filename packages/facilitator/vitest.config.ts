import { defineConfig } from "vitest/config";

// NestJS decorators run under esbuild's experimentalDecorators transform.
// emitDecoratorMetadata is NOT available here — DI in this package therefore
// always uses explicit @Inject(TOKEN), never implicit constructor-type
// injection.
export default defineConfig({
  test: {
    name: "facilitator",
    include: ["test/**/*.test.ts"],
  },
});
