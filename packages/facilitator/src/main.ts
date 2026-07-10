import "reflect-metadata";
import { NestFactory } from "@nestjs/core";
import { Logger } from "nestjs-pino";
import { AppModule } from "./app.module.js";
import { buildConfig } from "./config/schema.js";
import { configureApp } from "./configure-app.js";

async function bootstrap(): Promise<void> {
  const config = buildConfig(process.env); // throws on invalid config — fail before wiring
  const app = await NestFactory.create(AppModule.forRoot(config), { bufferLogs: true });
  app.useLogger(app.get(Logger));
  app.enableShutdownHooks();
  configureApp(app, config);
  await app.listen(config.server.port, config.server.host);
}

bootstrap().catch((err: unknown) => {
  // eslint-disable-next-line no-console -- logger may not exist if config failed
  console.error("facilitator failed to start:", err);
  process.exit(1);
});
