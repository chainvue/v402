import "reflect-metadata";
import { Test } from "@nestjs/testing";
import { SchedulerRegistry } from "@nestjs/schedule";
import type { INestApplication } from "@nestjs/common";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { IStorage } from "@chainvue/v402-storage";
import { MockVerusRpc } from "@chainvue/v402-verus-rpc";
import { AppModule } from "../src/app.module.js";
import { buildConfig } from "../src/config/schema.js";
import { configureApp } from "../src/configure-app.js";
import { STORAGE, VERUS_RPC } from "../src/core/core.module.js";
import { MaintenanceService } from "../src/maintenance/maintenance.service.js";

const NOW = Math.floor(Date.now() / 1000);

async function bootApp(overrides: Record<string, unknown> = {}): Promise<INestApplication> {
  const config = buildConfig(
    { NODE_ENV: "test", FACILITATOR_AUTH_TOKEN: "mw-token" },
    {
      db: { path: ":memory:" },
      logging: { level: "silent" },
      watcher: { mode: "simulated" },
      ...overrides,
    },
  );
  const moduleRef = await Test.createTestingModule({ imports: [AppModule.forRoot(config)] })
    .overrideProvider(VERUS_RPC)
    .useValue(new MockVerusRpc())
    .compile();
  const app = moduleRef.createNestApplication();
  configureApp(
    app,
    buildConfig({}, { cors: (overrides["cors"] as Record<string, unknown> | undefined) ?? { allowedOrigins: [] } }),
  );
  await app.init();
  return app;
}

async function fund(storage: IStorage, identityId: string, sats: bigint): Promise<void> {
  const deposit = await storage.insertDeposit({
    identityId,
    amountSats: sats,
    currency: "VRSCTEST",
    txid: `fund-${identityId}`,
    vout: 0,
    blockHeight: 1,
    blockHash: "h1",
    confirmations: 10,
    detectedAt: NOW,
    origin: "real",
  });
  await storage.creditDeposit(deposit.id, NOW);
}

describe("maintenance jobs (e2e)", () => {
  let app: INestApplication;
  let storage: IStorage;
  let maintenance: MaintenanceService;

  beforeAll(async () => {
    app = await bootApp();
    storage = app.get<IStorage>(STORAGE);
    maintenance = app.get(MaintenanceService);
  });

  afterAll(async () => {
    await app.close();
  });

  it("reaper refunds reservations older than reserveTtl and leaves fresh ones", async () => {
    await fund(storage, "agent@", 100_000n);
    await storage.reservePayment({
      requestId: "01H8XG7Q4M2N8P5R7T3V9WXOLD",
      identityId: "agent@",
      issuedAt: NOW - 400,
      receivedAt: NOW - 400, // older than reserveTtl 300
      amountSats: 30_000n,
      method: "GET",
      path: "/x",
    });
    await storage.reservePayment({
      requestId: "01H8XG7Q4M2N8P5R7T3V9WXNEW",
      identityId: "agent@",
      issuedAt: NOW,
      receivedAt: NOW,
      amountSats: 10_000n,
      method: "GET",
      path: "/x",
    });

    const reaped = await maintenance.runReaper();
    expect(reaped).toEqual(["01H8XG7Q4M2N8P5R7T3V9WXOLD"]);
    expect((await storage.getSpentRequest("01H8XG7Q4M2N8P5R7T3V9WXOLD"))?.status).toBe("error");
    expect((await storage.getSpentRequest("01H8XG7Q4M2N8P5R7T3V9WXNEW"))?.status).toBe("reserved");
    expect((await storage.getIdentity("agent@"))?.balanceSats).toBe(90_000n); // 100k − 10k still reserved; 30k refunded
  });

  it("cleanup purges only rows past the retention horizon (600s > reserveTtl + window)", async () => {
    await storage.recordBalanceQuery({
      requestId: "01H8XG7Q4M2N8P5R7T3V9WXANC",
      identityId: "agent@",
      issuedAt: NOW - 700, // beyond the 600s horizon
      receivedAt: NOW - 700,
      method: "GET",
      path: "/v1/balance",
    });
    const removed = await maintenance.runCleanup();
    expect(removed).toBe(1);
    // rows inside the horizon survive (incl. the reaped one — still replay-protected)
    expect(await storage.getSpentRequest("01H8XG7Q4M2N8P5R7T3V9WXOLD")).toBeDefined();
  });

  it("registers the reconciliation cron when enabled", () => {
    const registry = app.get(SchedulerRegistry);
    expect(registry.getCronJob("reconciliation")).toBeDefined();
    expect(registry.getIntervals()).toEqual(expect.arrayContaining(["reaper", "cleanup", "watcher-metrics"]));
  });

  it("skips the reconciliation cron when disabled", async () => {
    const disabled = await bootApp({ reconciliation: { enabled: false } });
    try {
      expect(() => disabled.get(SchedulerRegistry).getCronJob("reconciliation")).toThrow();
    } finally {
      await disabled.close();
    }
  });

  it("updates watcher/circuit gauges without a real client", async () => {
    maintenance.updateGauges(); // MockVerusRpc: circuit gauge untouched, watcher lag from simulated watcher
    const response = await request(app.getHttpServer()).get("/metrics").expect(200);
    expect(response.text).toMatch(/v402_watcher_lag_blocks 0/);
  });
});

describe("throttling (e2e)", () => {
  it("throttles unauthenticated requests, skips valid tokens and infrastructure probes", async () => {
    const app = await bootApp({ throttle: { unauthPerMinute: 3 } });
    try {
      const server = app.getHttpServer();
      for (let i = 0; i < 3; i++) {
        await request(server).get("/.well-known/v402").expect(200);
      }
      await request(server).get("/.well-known/v402").expect(429); // quota exhausted

      // valid middleware token bypasses the quota entirely
      for (let i = 0; i < 5; i++) {
        await request(server).post("/v1/commit").auth("mw", "mw-token").send({ requestId: "x".repeat(26) });
      }
      // health + metrics stay reachable for probes
      await request(server).get("/v1/health").expect(200);
      await request(server).get("/metrics").expect(200);
    } finally {
      await app.close();
    }
  });
});

describe("CORS (e2e)", () => {
  it("emits no CORS headers by default (deny-all)", async () => {
    const app = await bootApp();
    try {
      const response = await request(app.getHttpServer())
        .get("/.well-known/v402")
        .set("Origin", "https://evil.example.com")
        .expect(200);
      expect(response.headers["access-control-allow-origin"]).toBeUndefined();
    } finally {
      await app.close();
    }
  });

  it("allows configured origins with the v402 header set", async () => {
    const app = await bootApp({ cors: { allowedOrigins: ["https://app.example.com"] } });
    try {
      const response = await request(app.getHttpServer())
        .options("/v1/balance")
        .set("Origin", "https://app.example.com")
        .set("Access-Control-Request-Method", "GET")
        .set("Access-Control-Request-Headers", "X-V402-Payer,X-V402-Signature");
      expect(response.headers["access-control-allow-origin"]).toBe("https://app.example.com");
      expect(response.headers["access-control-allow-headers"]).toContain("X-V402-Payer");
      expect(response.headers["access-control-allow-credentials"]).toBeUndefined();
    } finally {
      await app.close();
    }
  });
});
