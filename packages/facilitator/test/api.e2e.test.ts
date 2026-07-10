import "reflect-metadata";
import { Test } from "@nestjs/testing";
import type { INestApplication } from "@nestjs/common";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { IStorage } from "@chainvue/v402-storage";
import { MockVerusRpc, VerusRpcError } from "@chainvue/v402-verus-rpc";
import { AppModule } from "../src/app.module.js";
import { buildConfig } from "../src/config/schema.js";
import { STORAGE, VERUS_RPC } from "../src/core/core.module.js";

const TOKEN = "test-middleware-token";
const PAYER = "v402test.demoAgent@";
const PAYER_KEY = "v402test.demoagent@";
const REQUEST_ID = "01H8XG7Q4M2N8P5R7T3V9WXYZA";
const ISSUED_AT = Math.floor(Date.now() / 1000);

function paymentBody(overrides: { amount?: string; requestId?: string; scheme?: string } = {}) {
  return {
    method: "GET",
    path: "/api/tx/abc",
    headers: {
      "x-v402-scheme": overrides.scheme ?? "verus-prepaid-sig",
      "x-v402-payer": PAYER,
      "x-v402-amount": overrides.amount ?? "0.001",
      "x-v402-request-id": overrides.requestId ?? REQUEST_ID,
      "x-v402-issued-at": String(ISSUED_AT),
      "x-v402-signature": "SGVsbG8rL3dvcmxkQUJDRA==",
    },
    policy: { priceHuman: "0.001", bodyHashPolicy: "optional" },
  };
}

describe("facilitator payment API (e2e)", () => {
  let app: INestApplication;
  let storage: IStorage;
  let signatureValid = true;

  beforeAll(async () => {
    const config = buildConfig(
      { NODE_ENV: "test", FACILITATOR_AUTH_TOKEN: TOKEN },
      { db: { path: ":memory:" }, logging: { level: "silent" }, watcher: { mode: "simulated" } },
    );
    const rpc = new MockVerusRpc({
      verifyMessage: async () => signatureValid,
      getIdentity: async (nameOrAddress) => {
        if (nameOrAddress !== "fum@") throw new VerusRpcError("getidentity", -5, "Invalid identity");
        return {
          identity: {
            name: "fum",
            identityaddress: "i4KtZ8jeMipNJfAdmfxkzQZKmaGpjvhYKe",
            parent: "iChain",
            systemid: "iChain",
            primaryaddresses: ["RPrimary"],
            minimumsignatures: 1,
            revocationauthority: "x",
            recoveryauthority: "x",
            flags: 0,
            version: 3,
            timelock: 0,
          },
          status: "active",
          blockheight: 1,
          fullyqualifiedname: "fum.VRSCTEST@",
        };
      },
    });
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule.forRoot(config)],
    })
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

  async function fund(sats: bigint, txid: string): Promise<void> {
    const deposit = await storage.insertDeposit({
      identityId: PAYER_KEY,
      amountSats: sats,
      currency: "VRSCTEST",
      txid,
      vout: 0,
      blockHeight: 1,
      blockHash: "h1",
      confirmations: 10,
      detectedAt: ISSUED_AT,
      origin: "real",
    });
    await storage.creditDeposit(deposit.id, ISSUED_AT);
  }

  describe("auth", () => {
    it("rejects requests without Basic auth", async () => {
      await request(app.getHttpServer()).post("/v1/verify").send(paymentBody()).expect(401);
    });

    it("rejects a wrong token", async () => {
      await request(app.getHttpServer()).post("/v1/verify").auth("mw", "wrong").send(paymentBody()).expect(401);
    });
  });

  describe("POST /v1/verify", () => {
    it("verifies statelessly without balance requirements", async () => {
      const response = await request(app.getHttpServer())
        .post("/v1/verify")
        .auth("mw", TOKEN)
        .send(paymentBody())
        .expect(201);
      expect(response.body).toEqual({ ok: true, requestId: REQUEST_ID, payer: PAYER_KEY, amountSats: "100000" });
      expect(await storage.getSpentRequest(REQUEST_ID)).toBeUndefined();
    });

    it("maps verifier errors onto their HTTP status (price mismatch → 402)", async () => {
      const response = await request(app.getHttpServer())
        .post("/v1/verify")
        .auth("mw", TOKEN)
        .send(paymentBody({ amount: "0.002" }))
        .expect(402);
      expect(response.body.error.code).toBe("price-mismatch");
    });

    it("rejects unknown schemes with the supported list", async () => {
      const response = await request(app.getHttpServer())
        .post("/v1/verify")
        .auth("mw", TOKEN)
        .send(paymentBody({ scheme: "evm-eip3009" }))
        .expect(402);
      expect(response.body.error).toMatchObject({
        code: "unsupported-scheme",
        details: { supportedSchemes: ["verus-prepaid-sig"] },
      });
    });

    it("rejects malformed bodies with the Zod issues", async () => {
      const response = await request(app.getHttpServer())
        .post("/v1/verify")
        .auth("mw", TOKEN)
        .send({ method: "GET" })
        .expect(400);
      expect(response.body.error.code).toBe("invalid-body");
    });
  });

  describe("POST /v1/reserve → commit / rollback lifecycle", () => {
    it("402 no-balance before any deposit", async () => {
      const response = await request(app.getHttpServer())
        .post("/v1/reserve")
        .auth("mw", TOKEN)
        .send(paymentBody({ requestId: "01H8XG7Q4M2N8P5R7T3V9WXYZB" }))
        .expect(402);
      expect(response.body.error.code).toBe("no-balance");
    });

    it("reserves, replays as 409, commits idempotently", async () => {
      await fund(100_000n, "fund-1");
      const reserved = await request(app.getHttpServer())
        .post("/v1/reserve")
        .auth("mw", TOKEN)
        .send(paymentBody())
        .expect(201);
      expect(reserved.body).toEqual({
        ok: true,
        requestId: REQUEST_ID,
        payer: PAYER_KEY,
        amountSats: "100000",
        balanceAfterSats: "0",
      });

      const replay = await request(app.getHttpServer())
        .post("/v1/reserve")
        .auth("mw", TOKEN)
        .send(paymentBody())
        .expect(409);
      expect(replay.body.error).toMatchObject({ code: "replay", details: { previousStatus: "reserved" } });

      const committed = await request(app.getHttpServer())
        .post("/v1/commit")
        .auth("mw", TOKEN)
        .send({ requestId: REQUEST_ID, responseBytes: 1234 })
        .expect(201);
      expect(committed.body).toEqual({ ok: true, alreadyCommitted: false, late: false });

      const again = await request(app.getHttpServer())
        .post("/v1/commit")
        .auth("mw", TOKEN)
        .send({ requestId: REQUEST_ID })
        .expect(201);
      expect(again.body).toEqual({ ok: true, alreadyCommitted: true, late: false });

      const rollback = await request(app.getHttpServer())
        .post("/v1/rollback")
        .auth("mw", TOKEN)
        .send({ requestId: REQUEST_ID })
        .expect(409);
      expect(rollback.body.error.code).toBe("invalid-state");
    });

    it("404s commits of unknown requestIds", async () => {
      const response = await request(app.getHttpServer())
        .post("/v1/commit")
        .auth("mw", TOKEN)
        .send({ requestId: "01UNKNOWNREQUESTIDXXXXXXXX" })
        .expect(404);
      expect(response.body.error.code).toBe("unknown-request");
    });

    it("rejects invalid signatures with 402", async () => {
      signatureValid = false;
      const response = await request(app.getHttpServer())
        .post("/v1/reserve")
        .auth("mw", TOKEN)
        .send(paymentBody({ requestId: "01H8XG7Q4M2N8P5R7T3V9WXYZC" }))
        .expect(402);
      expect(response.body.error.code).toBe("invalid-signature");
      signatureValid = true;
    });
  });

  describe("GET /v1/identity/:id", () => {
    it("returns the on-chain identity plus the local account view", async () => {
      const response = await request(app.getHttpServer()).get("/v1/identity/fum@").auth("mw", TOKEN).expect(200);
      expect(response.body).toMatchObject({
        ok: true,
        fullyqualifiedname: "fum.VRSCTEST@",
        identity: { identityaddress: "i4KtZ8jeMipNJfAdmfxkzQZKmaGpjvhYKe", minimumsignatures: 1 },
        account: null,
      });
    });

    it("404s unknown identities", async () => {
      const response = await request(app.getHttpServer()).get("/v1/identity/nope@").auth("mw", TOKEN).expect(404);
      expect(response.body.error.code).toBe("unknown-identity");
    });
  });
});
