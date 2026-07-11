import "reflect-metadata";
import { createHash } from "node:crypto";
import { Test } from "@nestjs/testing";
import type { INestApplication } from "@nestjs/common";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { InMemoryStorage } from "@chainvue/v402-storage";
import { MockVerusRpc } from "@chainvue/v402-verus-rpc";
import { AppModule } from "../src/app.module.js";

const PAYER = "v402test.demoAgent@";
const PAYER_KEY = "v402test.demoagent@";
const ISSUED_AT = Math.floor(Date.now() / 1000);

let ulidCounter = 0;
function freshUlid(): string {
  return `01H8XG7Q4M2N8P5R7T3V9W${String(ulidCounter++).padStart(4, "0")}`;
}

function paymentHeaders(amount: string, extra: Record<string, string> = {}): Record<string, string> {
  return {
    "x-v402-scheme": "verus-prepaid-sig",
    "x-v402-payer": PAYER,
    "x-v402-amount": amount,
    "x-v402-request-id": freshUlid(),
    "x-v402-issued-at": String(ISSUED_AT),
    "x-v402-signature": "SGVsbG8rL3dvcmxkQUJDRA==",
    ...extra,
  };
}

function extensionsFor(body: string): string {
  const hash = createHash("sha256").update(body, "utf8").digest("hex");
  return Buffer.from(`scheme.bodyHash: sha256:${hash}`, "utf8").toString("base64");
}

describe("demo-server smoke test (plan step 19)", () => {
  let app: INestApplication;
  let storage: InMemoryStorage;

  beforeAll(async () => {
    storage = new InMemoryStorage();
    await storage.initialize();
    const deposit = await storage.insertDeposit({
      identityId: PAYER_KEY,
      amountSats: 10_000_000n, // 0.1 VRSCTEST — plenty for the smoke run
      currency: "VRSCTEST",
      txid: "fund",
      vout: 0,
      blockHeight: 1,
      blockHash: "h1",
      confirmations: 10,
      detectedAt: ISSUED_AT,
      origin: "real",
    });
    await storage.creditDeposit(deposit.id, ISSUED_AT);

    const moduleRef = await Test.createTestingModule({
      imports: [
        AppModule.forRoot({
          canonicalDomain: "localhost:3001",
          network: "vrsctest",
          asset: "VRSCTEST",
          payTo: "explorerAPI@",
          facilitatorUrl: "http://localhost:3000",
          db: { path: ":memory:" },
          verus: { rpcUrl: "http://unused", rpcUser: "", rpcPass: "" },
          storage,
          verusRpc: new MockVerusRpc({ verifyMessage: async () => true }),
        }),
      ],
    }).compile();
    app = moduleRef.createNestApplication({ rawBody: true });
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  it("serves the free index pointing at the discovery document", async () => {
    const response = await request(app.getHttpServer()).get("/").expect(200);
    expect(response.body.discovery).toBe("/.well-known/v402");
  });

  it("serves the rate card at /.well-known/v402 derived from route metadata", async () => {
    const response = await request(app.getHttpServer()).get("/.well-known/v402").expect(200);
    expect(response.body.endpoints).toEqual([
      { method: "POST", path: "/api/graphql", amount: "0.002", amountUnit: "human", asset: "VRSCTEST", bodyHashPolicy: "required" },
      { method: "GET", path: "/api/report", amount: "0.01", amountUnit: "human", asset: "VRSCTEST", bodyHashPolicy: "optional" },
      { method: "GET", path: "/api/status", amount: "0.0001", amountUnit: "human", asset: "VRSCTEST", bodyHashPolicy: "optional" },
      { method: "GET", path: "/api/tx/:txid", amount: "0.001", amountUnit: "human", asset: "VRSCTEST", bodyHashPolicy: "optional" },
    ]);
  });

  it.each([
    ["/api/status", "0.0001"],
    ["/api/tx/abc", "0.001"],
    ["/api/report", "0.01"],
  ])("%s challenges with 402 and its own price %s", async (path, price) => {
    const response = await request(app.getHttpServer()).get(path).expect(402);
    expect(response.body.version).toBe("v402/0.1");
    expect(response.body.accepts[0].amount).toBe(price);
  });

  it("POST /api/graphql challenges with 402 as well", async () => {
    const response = await request(app.getHttpServer()).post("/api/graphql").send({ query: "{ x }" }).expect(402);
    expect(response.body.accepts[0].amount).toBe("0.002");
  });

  it("serves all three GET endpoints against payment and debits correctly", async () => {
    const before = (await storage.getIdentity(PAYER_KEY))!.balanceSats;

    const status = await request(app.getHttpServer()).get("/api/status").set(paymentHeaders("0.0001")).expect(200);
    expect(status.body.synced).toBe(true);

    const tx = await request(app.getHttpServer()).get("/api/tx/abc123").set(paymentHeaders("0.001")).expect(200);
    expect(tx.body.txid).toBe("abc123");
    expect(tx.headers["x-v402-request-id"]).toBeDefined();

    const report = await request(app.getHttpServer()).get("/api/report").set(paymentHeaders("0.01")).expect(200);
    expect(report.body.period).toBe("2026-07");

    const after = (await storage.getIdentity(PAYER_KEY))!.balanceSats;
    expect(before - after).toBe(10_000n + 100_000n + 1_000_000n); // 0.0001 + 0.001 + 0.01
  });

  it("binds the GraphQL-style POST to its body via scheme.bodyHash", async () => {
    const body = JSON.stringify({ query: "{ blocks { height } }" });
    const response = await request(app.getHttpServer())
      .post("/api/graphql")
      .set(paymentHeaders("0.002", { "x-v402-extensions": extensionsFor(body), "content-type": "application/json" }))
      .send(body)
      .expect(201);
    expect(response.body).toEqual({ data: { echo: "{ blocks { height } }" } });
  });

  it("rejects a body-carrying POST without the bodyHash extension (required policy)", async () => {
    const response = await request(app.getHttpServer())
      .post("/api/graphql")
      .set(paymentHeaders("0.002"))
      .send({ query: "{ x }" })
      .expect(400);
    expect(response.body.error.code).toBe("body-hash-required");
  });

  it("rejects a tampered body (hash of a different payload)", async () => {
    const response = await request(app.getHttpServer())
      .post("/api/graphql")
      .set(
        paymentHeaders("0.002", {
          "x-v402-extensions": extensionsFor('{"query":"{ original }"}'),
          "content-type": "application/json",
        }),
      )
      .send('{"query":"{ tampered }"}')
      .expect(400);
    expect(response.body.error.code).toBe("body-hash-mismatch");
  });
});
