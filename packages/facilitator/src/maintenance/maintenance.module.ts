import { Module } from "@nestjs/common";
import { ScheduleModule } from "@nestjs/schedule";
import { AdminModule } from "../admin/admin.module.js";
import { MetricsModule } from "../metrics/metrics.module.js";
import { MaintenanceService } from "./maintenance.service.js";

@Module({
  imports: [ScheduleModule.forRoot(), MetricsModule, AdminModule],
  providers: [MaintenanceService],
  exports: [MaintenanceService],
})
export class MaintenanceModule {}
