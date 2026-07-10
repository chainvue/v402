import { Module, type DynamicModule } from "@nestjs/common";
import { V402Module, type V402ModuleOptions } from "@chainvue/v402-nestjs";
import { demoOptionsFromEnv } from "./config.js";
import { DemoController } from "./demo.controller.js";

/**
 * The whole v402 integration is the single V402Module.forRoot line —
 * everything else is a normal NestJS app.
 */
@Module({})
export class AppModule {
  static forRoot(options?: V402ModuleOptions): DynamicModule {
    return {
      module: AppModule,
      imports: [V402Module.forRoot(options ?? demoOptionsFromEnv(process.env))],
      controllers: [DemoController],
    };
  }
}
