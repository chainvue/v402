import { Module } from "@nestjs/common";
import { MetricsModule } from "../metrics/metrics.module.js";
import { BalanceController } from "./balance.controller.js";
import { DiscoveryController } from "./discovery.controller.js";
import { HealthController } from "./health.controller.js";
import { IdentityController } from "./identity.controller.js";
import { LedgerController } from "./ledger.controller.js";
import { PaymentsController } from "./payments.controller.js";
import { TopupController } from "./topup.controller.js";

@Module({
  imports: [MetricsModule],
  controllers: [
    PaymentsController,
    IdentityController,
    DiscoveryController,
    TopupController,
    BalanceController,
    LedgerController,
    HealthController,
  ],
})
export class ApiModule {}
