import { Module } from "@nestjs/common";
import { MetricsModule } from "../metrics/metrics.module.js";
import { ReconciliationService } from "../reconciliation/reconciliation.service.js";
import { AdminController } from "./admin.controller.js";

@Module({
  imports: [MetricsModule],
  providers: [ReconciliationService],
  controllers: [AdminController],
  exports: [ReconciliationService],
})
export class AdminModule {}
