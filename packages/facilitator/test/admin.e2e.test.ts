import "reflect-metadata";
import { Test } from "@nestjs/testing";
import type { INestApplication } from "@nestjs/common";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { IStorage } from "@chainvue/v402-storage";
import { MockVerusRpc } from "@chainvue/v402-verus-rpc";
import { AppModule } from "../src/app.module.js";
import { buildConfig } from "../src/config/schema.js";
import { STORAGE, VERUS_RPC } from "../src/core/core.module.js";

const ADMIN_TOKEN = "test-admin-token";

async function bootApp(watcherMode: "real" | "simulated"): Promise<{ app: INestApplication; storage: IStorage }> {
  const config = buildConfig(
    { NODE_ENV: "test", V402_ADMIN_TOKEN: ADMIN_TOKEN },
    {
      db: { path: ":memory:" },
      logging: { level: "silent" },
      watcher: { mode: watcherMode, intervalMs: 100_000 },
    },
  );
  const rpc = new MockVerusRpc({
    getCurrencyBalance: async () => ({ VRSCTEST: 0.005 }),
  });
  const moduleRef = await Test.createTestingModule({ imports: [AppModule.forRoot(config)] })
    .overrideProvider(VERUS_RPC)
    .useValue(rpc)
    .compile();
  const app = moduleRef.createNestApplication();
  await app.init();
  return { app, storage: app.get<IStorage>(STORAGE) };
}

describe("admin endpoints (e2e, simulated watcher)", () => {
  let app: INestApplication;
  let storage: IStorage;

  beforeAll(async () => {
    ({ app, storage } = await bootApp("simulated"));
  });

  afterAll(async () => {
    await app.close();
  });

  const authed = (path: string) => request(app.getHttpServer()).post(path).auth(ADMIN_TOKEN, { type: "bearer" });

  describe("auth", () => {
    it("rejects requests without the Bearer token", async () => {
      await request(app.getHttpServer()).post("/admin/reconcile").expect(401);
    });

    it("rejects a wrong token", async () => {
      await request(app.getHttpServer())
        .post("/admin/reconcile")
        .auth("wrong-token", { type: "bearer" })
        .expect(401);
    });
  });

  describe("POST /admin/simulate-deposit", () => {
    it("credits a fake deposit instantly with normalized identity", async () => {
      const response = await authed("/admin/simulate-deposit")
        .send({ identity: "v402.DemoAgent@", amount: "0.005" })
        .expect(201);
      expect(response.body).toMatchObject({
        ok: true,
        identity: "v402.demoagent@",
        balanceAfterSats: "500000",
        deposit: { origin: "simulated" },
      });
      expect((await storage.getIdentity("v402.demoagent@"))?.balanceSats).toBe(500_000n);
    });

    it("409s duplicate txids", async () => {
      await authed("/admin/simulate-deposit").send({ identity: "a@", amount: "1", txid: "sim-dup" }).expect(201);
      const response = await authed("/admin/simulate-deposit")
        .send({ identity: "a@", amount: "1", txid: "sim-dup" })
        .expect(409);
      expect(response.body.error.code).toBe("duplicate-deposit");
    });

    it("400s invalid bodies", async () => {
      await authed("/admin/simulate-deposit").send({ identity: "no-at", amount: "1" }).expect(400);
      await authed("/admin/simulate-deposit").send({ identity: "a@", amount: "1,5" }).expect(400);
    });
  });

  describe("POST /admin/credit", () => {
    it("credits manually with a full ledger trail (origin simulated, excluded from crosscheck)", async () => {
      const response = await authed("/admin/credit")
        .send({ identity: "Support.Case@", amount: "0.001", note: "missed deposit #42" })
        .expect(201);
      expect(response.body).toMatchObject({ ok: true, identity: "support.case@", balanceAfterSats: "100000" });
      const summary = await storage.getLedgerSummary("support.case@");
      expect(summary.sumSats).toBe(100_000n);
      expect(await storage.sumCreditedDeposits({ excludeSimulated: true })).toBe(0n);
    });
  });

  describe("POST /admin/reconcile", () => {
    it("verifies the ledger invariants and records the run", async () => {
      const response = await authed("/admin/reconcile").send().expect(201);
      expect(response.body).toMatchObject({
        ok: true,
        mismatches: 0,
        detail: [],
        onChain: { available: true, creditedDepositSats: "0", chainBalanceSats: "500000" },
      });
      expect(response.body.identitiesChecked).toBeGreaterThanOrEqual(3);
      const runs = await storage.listReconciliationRuns();
      expect(runs.length).toBeGreaterThanOrEqual(1);
      expect(runs[0]?.mismatches).toBe(0);
    });
  });
});

describe("admin endpoints (e2e, real watcher)", () => {
  it("simulate-deposit is rejected outside simulated mode", async () => {
    const { app } = await bootApp("real");
    try {
      const response = await request(app.getHttpServer())
        .post("/admin/simulate-deposit")
        .auth(ADMIN_TOKEN, { type: "bearer" })
        .send({ identity: "a@", amount: "1" })
        .expect(409);
      expect(response.body.error.code).toBe("not-simulated");
    } finally {
      await app.close();
    }
  });
});
