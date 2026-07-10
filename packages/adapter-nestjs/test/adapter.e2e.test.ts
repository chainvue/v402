import "reflect-metadata";
import { Controller, Get, HttpException, INestApplication, Module, NotFoundException, Post } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { InMemoryStorage } from "@chainvue/v402-storage";
import { MockVerusRpc } from "@chainvue/v402-verus-rpc";
import { V402Module, V402Payment } from "../src/index.js";

const PAYER = "v402test.demoAgent@";
const PAYER_KEY = "v402test.demoagent@";
const ISSUED_AT = Math.floor(Date.now() / 1000);

let ulidCounter = 0;
function freshUlid(): string {
  return `01H8XG7Q4M2N8P5R7T3V9W${String(ulidCounter++).padStart(4, "0").replace(/[ILOU89]/g, "X")}`;
}

function paymentHeaders(overrides: Record<string, string> = {}): Record<string, string> {
  return {
    "x-v402-scheme": "verus-prepaid-sig",
    "x-v402-payer": PAYER,
    "x-v402-amount": "0.001",
    "x-v402-request-id": freshUlid(),
    "x-v402-issued-at": String(ISSUED_AT),
    "x-v402-signature": "SGVsbG8rL3dvcmxkQUJDRA==",
    ...overrides,
  };
}

@Controller()
class DemoController {
  @Get("free")
  free(): unknown {
    return { free: true };
  }

  @Get("api/tx/:id")
  @V402Payment("0.001")
  paid(): unknown {
    return { tx: "data" };
  }

  @Get("boom")
  @V402Payment("0.001")
  boom(): never {
    throw new HttpException("upstream exploded", 500);
  }

  @Get("missing")
  @V402Payment("0.001")
  missing(): never {
    throw new NotFoundException("no such tx");
  }

  @Post("upload")
  @V402Payment("0.002", { bodyHash: "required" })
  upload(): unknown {
    return { uploaded: true };
  }
}

describe("@chainvue/v402-nestjs adapter (e2e, in-process mode)", () => {
  let app: INestApplication;
  let storage: InMemoryStorage;

  beforeAll(async () => {
    storage = new InMemoryStorage();
    await storage.initialize();

    @Module({
      imports: [
        V402Module.forRoot({
          canonicalDomain: "explorer.example.com",
          network: "vrsctest",
          asset: "VRSCTEST",
          payTo: "explorerAPI@",
          facilitatorUrl: "http://facilitator.local:3000",
          db: { path: ":memory:" }, // unused — storage seam below
          verus: { rpcUrl: "http://unused", rpcUser: "", rpcPass: "" },
          storage,
          verusRpc: new MockVerusRpc({ verifyMessage: async () => true }),
        }),
      ],
      controllers: [DemoController],
    })
    class TestAppModule {}

    const moduleRef = await Test.createTestingModule({ imports: [TestAppModule] }).compile();
    app = moduleRef.createNestApplication();
    await app.init();
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

  it("leaves undecorated routes untouched", async () => {
    const response = await request(app.getHttpServer()).get("/free").expect(200);
    expect(response.body).toEqual({ free: true });
    expect(response.headers["x-v402-request-id"]).toBeUndefined();
  });

  it("challenges unpaid requests with the normative 402 accepts array", async () => {
    const response = await request(app.getHttpServer()).get("/api/tx/abc").expect(402);
    expect(response.body.version).toBe("v402/0.1");
    expect(response.body.accepts).toEqual([
      {
        scheme: "verus-prepaid-sig",
        schemeVersion: "0.1",
        network: "vrsctest",
        asset: "VRSCTEST",
        amount: "0.001",
        amountUnit: "human",
        payTo: "explorerAPI@",
        facilitator: "http://facilitator.local:3000",
        requiredHeaders: [
          "X-V402-Scheme",
          "X-V402-Payer",
          "X-V402-Amount",
          "X-V402-Request-Id",
          "X-V402-Issued-At",
          "X-V402-Signature",
        ],
        canonicalDomain: "explorer.example.com",
        topup: { depositAddress: "explorerAPI@", attribution: "sender-verusid" },
      },
    ]);
  });

  it("serves paid requests, commits, and sets the response headers", async () => {
    await fund(200_000n, "fund-1");
    const headers = paymentHeaders();
    const response = await request(app.getHttpServer()).get("/api/tx/abc").set(headers).expect(200);
    expect(response.body).toEqual({ tx: "data" });
    expect(response.headers["x-v402-request-id"]).toBe(headers["x-v402-request-id"]);
    expect(response.headers["x-v402-balance"]).toBe("0.001"); // 200k − 100k = 100k sats
    expect((await storage.getSpentRequest(headers["x-v402-request-id"]!))?.status).toBe("committed");
  });

  it("rolls back on 5xx so the client is not charged", async () => {
    const before = (await storage.getIdentity(PAYER_KEY))!.balanceSats;
    const headers = paymentHeaders();
    await request(app.getHttpServer()).get("/boom").set(headers).expect(500);
    expect((await storage.getSpentRequest(headers["x-v402-request-id"]!))?.status).toBe("error");
    expect((await storage.getIdentity(PAYER_KEY))!.balanceSats).toBe(before); // refunded
  });

  it("commits on 4xx — a definitive answer is a rendered service", async () => {
    const before = (await storage.getIdentity(PAYER_KEY))!.balanceSats;
    const headers = paymentHeaders();
    await request(app.getHttpServer()).get("/missing").set(headers).expect(404);
    expect((await storage.getSpentRequest(headers["x-v402-request-id"]!))?.status).toBe("committed");
    expect((await storage.getIdentity(PAYER_KEY))!.balanceSats).toBe(before - 100_000n);
  });

  it("rejects replays with 409", async () => {
    await fund(100_000n, "fund-replay"); // account drained by the tests above
    const headers = paymentHeaders();
    await request(app.getHttpServer()).get("/api/tx/abc").set(headers).expect(200);
    const replay = await request(app.getHttpServer()).get("/api/tx/abc").set(headers).expect(409);
    expect(replay.body.error).toMatchObject({ code: "replay", details: { previousStatus: "committed" } });
  });

  it("answers price mismatches with 402 + current accepts (M6 self-healing)", async () => {
    const response = await request(app.getHttpServer())
      .get("/api/tx/abc")
      .set(paymentHeaders({ "x-v402-amount": "0.009" }))
      .expect(402);
    expect(response.body.error.code).toBe("price-mismatch");
    expect(response.body.accepts[0].amount).toBe("0.001"); // client re-signs with this
  });

  it("rejects unknown schemes with 402 + accepts", async () => {
    const response = await request(app.getHttpServer())
      .get("/api/tx/abc")
      .set(paymentHeaders({ "x-v402-scheme": "evm-eip3009" }))
      .expect(402);
    expect(response.body.error.code).toBe("unsupported-scheme");
    expect(response.body.accepts).toHaveLength(1);
  });

  it("fails closed when a bodyHash policy needs raw bytes the app does not provide", async () => {
    // Nest test app created WITHOUT rawBody:true — required-policy uploads must not slip through
    await request(app.getHttpServer())
      .post("/upload")
      .set(paymentHeaders({ "x-v402-amount": "0.002" }))
      .send({ some: "body" })
      .expect(500);
  });
});
