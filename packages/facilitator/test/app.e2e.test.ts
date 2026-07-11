import "reflect-metadata";
import { Test } from "@nestjs/testing";
import type { INestApplication } from "@nestjs/common";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AppModule } from "../src/app.module.js";
import { buildConfig } from "../src/config/schema.js";

describe("facilitator scaffold (e2e)", () => {
  let app: INestApplication;

  beforeAll(async () => {
    const config = buildConfig(
      { NODE_ENV: "test" },
      { db: { path: ":memory:" }, logging: { level: "silent" }, watcher: { mode: "simulated" } },
    );
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule.forRoot(config)],
    }).compile();
    app = moduleRef.createNestApplication();
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  it("boots and serves Prometheus metrics with the v402 core set registered", async () => {
    const response = await request(app.getHttpServer()).get("/metrics").expect(200);
    expect(response.text).toContain("v402_requests_total");
    expect(response.text).toContain("v402_request_duration_seconds");
    expect(response.text).toContain("v402_circuit_state");
    expect(response.text).toContain("v402_identity_cache_events_total");
    expect(response.text).toContain("process_cpu_user_seconds_total"); // default metrics enabled
  });

  it("404s unknown routes", async () => {
    await request(app.getHttpServer()).get("/nope").expect(404);
  });
});

describe("facilitator scaffold in offline verifier mode (e2e)", () => {
  it("boots with the CachedIdentityProvider wired to the cache-events counter", async () => {
    const config = buildConfig(
      { NODE_ENV: "test", V402_VERIFIER_MODE: "offline" },
      { db: { path: ":memory:" }, logging: { level: "silent" }, watcher: { mode: "simulated" } },
    );
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule.forRoot(config)],
    }).compile();
    const app = moduleRef.createNestApplication();
    await app.init();
    try {
      const response = await request(app.getHttpServer()).get("/metrics").expect(200);
      expect(response.text).toContain("v402_identity_cache_events_total");
    } finally {
      await app.close();
    }
  });
});
