import { Module, type DynamicModule } from "@nestjs/common";
import { LoggerModule } from "nestjs-pino";
import { V402ConfigModule, V402_CONFIG } from "./config/config.module.js";
import type { FacilitatorConfig } from "./config/schema.js";
import { MetricsModule } from "./metrics/metrics.module.js";

/**
 * Root module. `forRoot()` reads config from process.env; tests inject a
 * pre-built config. Feature modules (verify/reserve API, UX endpoints,
 * admin, crons) are added in delivery steps 13–16.
 */
@Module({})
export class AppModule {
  static forRoot(config?: FacilitatorConfig): DynamicModule {
    return {
      module: AppModule,
      imports: [
        V402ConfigModule.forRoot(config),
        LoggerModule.forRootAsync({
          inject: [V402_CONFIG],
          useFactory: (cfg: FacilitatorConfig) => ({
            pinoHttp: {
              level: cfg.logging.level,
              // signatures are not secrets, but keep headers lean + never log auth material
              redact: ["req.headers.authorization", 'req.headers["x-v402-signature"]'],
              ...(cfg.logging.prettyPrint ? { transport: { target: "pino-pretty" } } : {}),
              autoLogging: {
                ignore: (req) => req.url === "/metrics",
              },
            },
          }),
        }),
        MetricsModule,
      ],
    };
  }
}
