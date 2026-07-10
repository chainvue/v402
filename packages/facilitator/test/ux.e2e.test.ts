import "reflect-metadata";
import { Test } from "@nestjs/testing";
import type { INestApplication } from "@nestjs/common";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { canonicalizeBalanceQuery } from "@chainvue/v402-protocol";
import type { IStorage } from "@chainvue/v402-storage";
import { MockVerusRpc } from "@chainvue/v402-verus-rpc";
import { AppModule } from "../src/app.module.js";
import { buildConfig } from "../src/config/schema.js";
import { STORAGE, VERUS_RPC } from "../src/core/core.module.js";

const PAYER = "v402.demoAgent@";
const PAYER_KEY = "v402.demoagent@";
const REQUEST_ID = "01H8XGABCDEF0123456789QRST";
const ISSUED_AT = Math.floor(Date.now() / 1000);
const SIGNATURE = "SGVsbG8rL3dvcmxkQUJDRA==";

describe("facilitator UX endpoints (e2e)", () => {
  let app: INestApplication;
  let storage: IStorage;
  const capturedCanonicals: string[] = [];

  beforeAll(async () => {
    const config = buildConfig(
      { NODE_ENV: "test" },
      {
        db: { path: ":memory:" },
        logging: { level: "silent" },
        watcher: { mode: "simulated" },
        payment: { canonicalDomain: "facilitator.example.com" },
      },
    );
    const rpc = new MockVerusRpc({
      verifyMessage: async (_signer, _sig, message) => {
        capturedCanonicals.push(message);
        return true;
      },
      getInfo: async () => ({ VRSCversion: "1.2.17", version: 1, name: "VRSCTEST", blocks: 1_140_000, chainid: "x" }),
    });
    const moduleRef = await Test.createTestingModule({ imports: [AppModule.forRoot(config)] })
      .overrideProvider(VERUS_RPC)
      .useValue(rpc)
      .compile();
    app = moduleRef.createNestApplication();
    await app.init();
    storage = app.get<IStorage>(STORAGE);
  });

  afterAll(async () => {
    await app.close();
  });

  describe("GET /.well-known/v402", () => {
    it("serves the public discovery document from config truth", async () => {
      const response = await request(app.getHttpServer()).get("/.well-known/v402").expect(200);
      expect(response.body).toMatchObject({
        supportedVersions: ["v402/0.1"],
        defaultVersion: "v402/0.1",
        deprecatedVersions: [],
        supportedExtensions: ["scheme.bodyHash"],
        defaultScheme: "verus-prepaid-sig",
        schemes: [
          { scheme: "verus-prepaid-sig", schemeVersion: "0.1", network: "vrsctest", asset: "VRSCTEST", payTo: "explorerAPI@" },
        ],
        topup: { depositAddress: "explorerAPI@", attribution: "sender-verusid" },
      });
    });
  });

  describe("GET /v1/topup-instructions", () => {
    it("returns text, payment URI and QR code (public)", async () => {
      const response = await request(app.getHttpServer())
        .get("/v1/topup-instructions")
        .query({ identity: PAYER, amount: "5" })
        .expect(200);
      expect(response.body.instructions.text).toBe("Send 5 VRSCTEST from v402.demoAgent@ to explorerAPI@");
      expect(response.body.instructions.paymentUri).toBe(
        "verus://send?to=explorerAPI%40&currency=VRSCTEST&amount=5&from=v402.demoAgent%40",
      );
      expect(response.body.instructions.qrCode).toMatch(/^data:image\/png;base64,/);
      expect(response.body).toMatchObject({
        network: "vrsctest",
        asset: "VRSCTEST",
        expectedConfirmations: 10,
        estimatedTimeMinutes: 10,
      });
    });

    it("amount is optional", async () => {
      const response = await request(app.getHttpServer())
        .get("/v1/topup-instructions")
        .query({ identity: PAYER })
        .expect(200);
      expect(response.body.instructions.paymentUri).not.toContain("amount=");
    });

    it.each([
      ["missing identity", {}],
      ["identity without @", { identity: "nope" }],
      ["invalid amount", { identity: PAYER, amount: "1,5" }],
    ])("400s on %s", async (_name, query) => {
      await request(app.getHttpServer()).get("/v1/topup-instructions").query(query).expect(400);
    });
  });

  describe("GET /v1/balance (signature-authenticated)", () => {
    const balanceHeaders = (overrides: Record<string, string> = {}) => ({
      "x-v402-payer": PAYER,
      "x-v402-request-id": REQUEST_ID,
      "x-v402-issued-at": String(ISSUED_AT),
      "x-v402-signature": SIGNATURE,
      ...overrides,
    });

    it("verifies the domain-separated balance-query payload and reports balance/reserved/available", async () => {
      const deposit = await storage.insertDeposit({
        identityId: PAYER_KEY,
        amountSats: 100_000n,
        currency: "VRSCTEST",
        txid: "fund-balance",
        vout: 0,
        blockHeight: 1,
        blockHash: "h1",
        confirmations: 10,
        detectedAt: ISSUED_AT,
        origin: "real",
      });
      await storage.creditDeposit(deposit.id, ISSUED_AT);
      await storage.reservePayment({
        requestId: "01H8XG7Q4M2N8P5R7T3V9WXYZA",
        identityId: PAYER_KEY,
        issuedAt: ISSUED_AT,
        receivedAt: ISSUED_AT,
        amountSats: 40_000n,
        method: "GET",
        path: "/x",
      });

      const response = await request(app.getHttpServer()).get("/v1/balance").set(balanceHeaders()).expect(200);
      expect(response.body).toMatchObject({
        identity: PAYER_KEY,
        balance: "0.001",
        reserved: "0.0004",
        available: "0.0006",
        balanceSats: "100000",
        reservedSats: "40000",
        availableSats: "60000",
      });
      // the signed payload is the domain-separated v402-balance-query canonical form
      expect(capturedCanonicals.at(-1)).toBe(
        canonicalizeBalanceQuery({
          canonicalDomain: "facilitator.example.com",
          network: "vrsctest",
          payer: PAYER,
          requestId: REQUEST_ID,
          issuedAt: ISSUED_AT,
        }),
      );
    });

    it("replays are rejected with 409 and the previous status", async () => {
      const response = await request(app.getHttpServer()).get("/v1/balance").set(balanceHeaders()).expect(409);
      expect(response.body.error).toMatchObject({ code: "replay", details: { previousStatus: "committed" } });
    });

    it("answers zero balances for identities without deposits", async () => {
      const response = await request(app.getHttpServer())
        .get("/v1/balance")
        .set(balanceHeaders({ "x-v402-payer": "ghost@", "x-v402-request-id": "01H8XGABCDEF0123456789QRSV" }))
        .expect(200);
      expect(response.body).toMatchObject({ identity: "ghost@", balance: "0", reserved: "0", available: "0" });
    });

    it.each([
      ["missing signature", { "x-v402-signature": "" }],
      ["bad requestId", { "x-v402-request-id": "not-a-ulid" }],
      ["stale issuedAt", { "x-v402-issued-at": String(ISSUED_AT - 10_000) }],
    ])("rejects %s", async (_name, overrides) => {
      const status = _name === "stale issuedAt" ? 400 : 400;
      await request(app.getHttpServer()).get("/v1/balance").set(balanceHeaders(overrides)).expect(status);
    });
  });

  describe("GET /v1/health", () => {
    it("reports ok with rpc info and watcher status", async () => {
      const response = await request(app.getHttpServer()).get("/v1/health").expect(200);
      expect(response.body).toMatchObject({
        status: "ok",
        verusRpc: { reachable: true, chain: "VRSCTEST", blocks: 1_140_000 },
        watcher: { mode: "simulated", running: true, lagBlocks: 0 },
      });
    });
  });
});

describe("health degradation with a real-mode watcher and unreachable node (e2e)", () => {
  it("reports 503 degraded", async () => {
    const config = buildConfig(
      { NODE_ENV: "test" },
      {
        db: { path: ":memory:" },
        logging: { level: "silent" },
        watcher: { mode: "real", intervalMs: 100_000 },
      },
    );
    const moduleRef = await Test.createTestingModule({ imports: [AppModule.forRoot(config)] })
      .overrideProvider(VERUS_RPC)
      .useValue(new MockVerusRpc()) // nothing stubbed: node fully unreachable
      .compile();
    const app = moduleRef.createNestApplication();
    await app.init();
    try {
      // first watcher poll fires on start and fails against the unstubbed mock
      await vi.waitFor(async () => {
        const response = await request(app.getHttpServer()).get("/v1/health");
        expect(response.status).toBe(503);
        expect(response.body.status).toBe("degraded");
        expect(response.body.verusRpc.reachable).toBe(false);
      });
    } finally {
      await app.close();
    }
  });
});
