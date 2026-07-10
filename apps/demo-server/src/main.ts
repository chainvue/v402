import "reflect-metadata";
import { NestFactory } from "@nestjs/core";
import { AppModule } from "./app.module.js";
import { demoPort } from "./config.js";

async function bootstrap(): Promise<void> {
  // rawBody: true is REQUIRED for bodyHash-bound endpoints (POST /api/graphql)
  const app = await NestFactory.create(AppModule.forRoot(), { rawBody: true });
  app.enableShutdownHooks();
  await app.listen(demoPort(process.env));
}

bootstrap().catch((err: unknown) => {
  // eslint-disable-next-line no-console -- demo app, no logger stack
  console.error("demo-server failed to start:", err);
  process.exit(1);
});
