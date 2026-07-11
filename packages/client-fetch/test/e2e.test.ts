import "reflect-metadata";
import type { AddressInfo } from "node:net";
import { Controller, Get, INestApplication, Module, Post } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { V402Module, V402Payment } from "@chainvue/v402-nestjs";
import { isValidUlid } from "@chainvue/v402-protocol";
import { InMemoryStorage } from "@chainvue/v402-storage";
import { MockVerusRpc } from "@chainvue/v402-verus-rpc";
import { LocalKeySigner, decodeWif, signAddressMessage } from "@chainvue/v402-signer-verus";
import { AcceptsCache, ulid, wrapFetchWithPayment } from "../src/index.js";

const KEY_A_WIF = "Uw81VDAH8zrvbGJLfo1nfLaWN9tnGMo2U3bB81Zg8MKBvakrNXqP";
const KEY_A_PRIV = decodeWif(KEY_A_WIF);
const PAYER = "v402test.demoAgent@";
const PAYER_KEY = "v402test.demoagent@";

@Controller()
class ApiController {
  @Get("free")
  free(): unknown {
    return { free: true };
  }

  @Get("api/tx/:id")
  @V402Payment("0.001")
  paid(): unknown {
    return { paid: true };
  }

  @Post("api/graphql")
  @V402Payment("0.002", { bodyHash: "required" })
  graphql(): unknown {
    return { data: true };
  }
}

describe("wrapFetchWithPayment against a real v402 server (cryptographic verification)", () => {
  let app: INestApplication;
  let storage: InMemoryStorage;
  let baseUrl: string;
  const paidFetch = () =>
    wrapFetchWithPayment(fetch, { payer: PAYER, signer: new LocalKeySigner(KEY_A_WIF) });

  beforeAll(async () => {
    storage = new InMemoryStorage();
    await storage.initialize();
    const deposit = await storage.insertDeposit({
      identityId: PAYER_KEY,
      amountSats: 100_000_000n, // 1 VRSCTEST
      currency: "VRSCTEST",
      txid: "fund",
      vout: 0,
      blockHeight: 1,
      blockHash: "h1",
      confirmations: 10,
      detectedAt: 1,
      origin: "real",
    });
    await storage.creditDeposit(deposit.id, 1);

    @Module({
      imports: [
        V402Module.forRoot({
          canonicalDomain: "localhost:0", // placeholder; replaced below via advertisement? no — fixed value used by both sides
          network: "vrsctest",
          asset: "VRSCTEST",
          payTo: "explorerAPI@",
          facilitatorUrl: "http://facilitator.local",
          db: { path: ":memory:" },
          verus: { rpcUrl: "http://unused", rpcUser: "", rpcPass: "" },
          storage,
          verusRpc: new MockVerusRpc({
            // REAL verification: recompute the deterministic signature for the
            // rebuilt canonical string — byte mismatch = reject
            verifyMessage: async (_signer, signature, message) =>
              signature === signAddressMessage(message, KEY_A_PRIV),
          }),
        }),
      ],
      controllers: [ApiController],
    })
    class TestAppModule {}

    const moduleRef = await Test.createTestingModule({ imports: [TestAppModule] }).compile();
    app = moduleRef.createNestApplication({ rawBody: true });
    await app.init();
    await app.listen(0, "127.0.0.1");
    const address = app.getHttpServer().address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${address.port}`;
  });

  afterAll(async () => {
    await app.close();
  });

  it("passes free endpoints through untouched", async () => {
    const response = await paidFetch()(`${baseUrl}/free`);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ free: true });
  });

  it("pays a 402 challenge transparently — the signature actually verifies", async () => {
    const response = await paidFetch()(`${baseUrl}/api/tx/abc`);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ paid: true });
    const requestId = response.headers.get("x-v402-request-id")!;
    expect(isValidUlid(requestId)).toBe(true);
    expect((await storage.getSpentRequest(requestId))?.status).toBe("committed");
  });

  it("attaches scheme.bodyHash automatically for body-carrying requests", async () => {
    const response = await paidFetch()(`${baseUrl}/api/graphql`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: '{"query":"{ x }"}',
    });
    expect(response.status).toBe(201);
    expect(await response.json()).toEqual({ data: true });
  });

  it("handles Promise.all([...100]) fully in parallel with unique requestIds (Q9)", async () => {
    const before = (await storage.getIdentity(PAYER_KEY))!.balanceSats;
    const clientFetch = paidFetch();
    const responses = await Promise.all(
      Array.from({ length: 100 }, () => clientFetch(`${baseUrl}/api/tx/parallel`)),
    );
    expect(responses.every((r) => r.status === 200)).toBe(true);
    const requestIds = responses.map((r) => r.headers.get("x-v402-request-id"));
    expect(new Set(requestIds).size).toBe(100);
    const after = (await storage.getIdentity(PAYER_KEY))!.balanceSats;
    expect(before - after).toBe(100n * 100_000n);
  });

  it("rejects Request objects with a clear error", () => {
    expect(() => paidFetch()(new Request(`${baseUrl}/free`))).toThrow(/not a Request object/);
  });

  it("surfaces unsupported body types as a client error", async () => {
    await expect(
      paidFetch()(`${baseUrl}/api/graphql`, { method: "POST", body: new FormData() }),
    ).rejects.toMatchObject({ name: "V402ClientError", code: "unsupported-body-type" });
  });

  describe("accepts cache", () => {
    let calls = 0;
    const countingFetch = ((input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
      calls++;
      return fetch(input, init);
    }) as typeof fetch;

    it("skips the unpaid preflight on repeat calls to the same endpoint", async () => {
      const clientFetch = wrapFetchWithPayment(countingFetch, { payer: PAYER, signer: new LocalKeySigner(KEY_A_WIF) });
      calls = 0;
      expect((await clientFetch(`${baseUrl}/api/tx/cached`)).status).toBe(200);
      expect(calls).toBe(2); // 402 preflight + paid request
      expect((await clientFetch(`${baseUrl}/api/tx/cached`)).status).toBe(200);
      expect(calls).toBe(3); // paid request only — challenge served from cache
    });

    it("self-heals a stale cached PRICE without an unpaid preflight (fresh ULID, exact debit)", async () => {
      const cache = new AcceptsCache();
      const clientFetch = wrapFetchWithPayment(countingFetch, {
        payer: PAYER,
        signer: new LocalKeySigner(KEY_A_WIF),
        acceptsCache: cache,
      });
      await clientFetch(`${baseUrl}/api/tx/seed`); // learn the real requirement
      const real = cache.get(`GET ${baseUrl}/api/tx/seed`)!;
      cache.set(`GET ${baseUrl}/api/tx/stale-price`, { ...real, amount: "0.005" });

      const before = (await storage.getIdentity(PAYER_KEY))!.balanceSats;
      calls = 0;
      const response = await clientFetch(`${baseUrl}/api/tx/stale-price`);
      expect(response.status).toBe(200);
      // stale paid attempt (402 price-mismatch) + re-signed paid request
      expect(calls).toBe(2);
      const after = (await storage.getIdentity(PAYER_KEY))!.balanceSats;
      expect(before - after).toBe(100_000n); // debited the REAL price, not the stale one
      // cache healed: next call pays directly
      calls = 0;
      expect((await clientFetch(`${baseUrl}/api/tx/stale-price`)).status).toBe(200);
      expect(calls).toBe(1);
    });

    it("self-heals a stale cached payTo (surfaces as invalid-signature) the same way", async () => {
      const cache = new AcceptsCache();
      const clientFetch = wrapFetchWithPayment(countingFetch, {
        payer: PAYER,
        signer: new LocalKeySigner(KEY_A_WIF),
        acceptsCache: cache,
      });
      await clientFetch(`${baseUrl}/api/tx/seed2`);
      const real = cache.get(`GET ${baseUrl}/api/tx/seed2`)!;
      cache.set(`GET ${baseUrl}/api/tx/stale-payto`, { ...real, payTo: "rotated@" });

      calls = 0;
      const response = await clientFetch(`${baseUrl}/api/tx/stale-payto`);
      expect(response.status).toBe(200);
      expect(calls).toBe(2); // 402 invalid-signature + re-signed from fresh accepts
    });

    it("acceptsCache: false restores the always-preflight behavior", async () => {
      const clientFetch = wrapFetchWithPayment(countingFetch, {
        payer: PAYER,
        signer: new LocalKeySigner(KEY_A_WIF),
        acceptsCache: false,
      });
      calls = 0;
      await clientFetch(`${baseUrl}/api/tx/uncached`);
      await clientFetch(`${baseUrl}/api/tx/uncached`);
      expect(calls).toBe(4); // two full handshakes
    });
  });
});

describe("ulid", () => {
  it("generates protocol-valid, unique ids", () => {
    const ids = new Set(Array.from({ length: 5000 }, () => ulid()));
    expect(ids.size).toBe(5000);
    for (const id of ids) expect(isValidUlid(id)).toBe(true);
  });
});
