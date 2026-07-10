import { Module, type DynamicModule, type ExecutionContext } from "@nestjs/common";
import { APP_GUARD } from "@nestjs/core";
import { ThrottlerGuard, ThrottlerModule } from "@nestjs/throttler";
import { LoggerModule } from "nestjs-pino";
import { AdminModule } from "./admin/admin.module.js";
import { ApiModule } from "./api/api.module.js";
import { basicPassword, tokenEquals } from "./auth/token-equals.js";
import { V402ConfigModule, V402_CONFIG } from "./config/config.module.js";
import type { FacilitatorConfig } from "./config/schema.js";
import { CoreModule } from "./core/core.module.js";
import { MaintenanceModule } from "./maintenance/maintenance.module.js";
import { MetricsModule } from "./metrics/metrics.module.js";

/**
 * Unauthenticated flood protection (plan § Rate Limiting): per-IP quota on
 * everything except infrastructure probes (/metrics, /v1/health) and
 * requests carrying a valid operator token (skipAuthenticated).
 */
function throttleSkip(config: FacilitatorConfig, context: ExecutionContext): boolean {
  const request = context.switchToHttp().getRequest<{ url?: string; headers: Record<string, string | undefined> }>();
  const url = request.url ?? "";
  if (url === "/metrics" || url === "/v1/health") return true;
  if (!config.throttle.skipAuthenticated) return false;
  const auth = request.headers["authorization"];
  if (auth === undefined) return false;
  const basic = basicPassword(auth);
  if (basic !== undefined) return tokenEquals(basic, config.facilitator.authToken);
  if (auth.startsWith("Bearer ")) return tokenEquals(auth.slice("Bearer ".length), config.ops.adminToken);
  return false;
}

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
        CoreModule.forRoot(),
        ThrottlerModule.forRootAsync({
          inject: [V402_CONFIG],
          useFactory: (cfg: FacilitatorConfig) => ({
            throttlers: [{ ttl: 60_000, limit: cfg.throttle.unauthPerMinute }],
            skipIf: (context: ExecutionContext) => throttleSkip(cfg, context),
          }),
        }),
        ApiModule,
        AdminModule,
        MaintenanceModule,
      ],
      providers: [{ provide: APP_GUARD, useClass: ThrottlerGuard }],
    };
  }
}
