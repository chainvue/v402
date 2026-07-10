import { Module } from "@nestjs/common";
import { MetricsModule } from "../metrics/metrics.module.js";
import { IdentityController } from "./identity.controller.js";
import { PaymentsController } from "./payments.controller.js";

@Module({
  imports: [MetricsModule],
  controllers: [PaymentsController, IdentityController],
})
export class ApiModule {}
