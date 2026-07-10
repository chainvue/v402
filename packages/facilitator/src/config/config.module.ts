import { Module, type DynamicModule } from "@nestjs/common";
import { buildConfig, type FacilitatorConfig } from "./schema.js";

/** DI token for the validated facilitator config. Always inject explicitly: `@Inject(V402_CONFIG)`. */
export const V402_CONFIG = Symbol("V402_CONFIG");

/**
 * Global config module. `forRoot()` builds from process.env (production
 * path); tests pass a pre-built config. Validation happens in buildConfig —
 * a bad config throws before the app wires anything else.
 */
@Module({})
export class V402ConfigModule {
  static forRoot(config?: FacilitatorConfig): DynamicModule {
    const value = config ?? buildConfig(process.env);
    return {
      module: V402ConfigModule,
      global: true,
      providers: [{ provide: V402_CONFIG, useValue: value }],
      exports: [V402_CONFIG],
    };
  }
}
