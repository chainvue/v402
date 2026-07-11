/**
 * Full-stack e2e: client (wrapFetchWithPayment) → v402-proxy → REAL
 * facilitator (Nest app over real HTTP) + dummy origin. Signature
 * verification is cryptographically real on the facilitator side (the mock
 * RPC recomputes the deterministic signature — byte mismatch = reject).
 */
import "reflect-metadata";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { Test } from "@nestjs/testing";
import type { INestApplication } from "@nestjs/common";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AppModule } from "@chainvue/v402-facilitator";
import { buildConfig } from "@chainvue/v402-facilitator";
import type { IStorage } from "@chainvue/v402-storage";
import { MockVerusRpc } from "@chainvue/v402-verus-rpc";
import { LocalKeySigner, decodeWif, signAddressMessage } from "@chainvue/v402-signer-verus";
import { wrapFetchWithPayment } from "@chainvue/v402-client-fetch";
import { STORAGE, VERUS_RPC } from "@chainvue/v402-facilitator";
import { buildProxyConfig, createProxyServer } from "../src/index.js";

const KEY_A_WIF = "Uw81VDAH8zrvbGJLfo1nfLaWN9tnGMo2U3bB81Zg8MKBvakrNXqP";
const KEY_A_PRIV = decodeWif(KEY_A_WIF);
const PAYER = "v402test.demoAgent@";
const PAYER_KEY = "v402test.demoagent@";
const TOKEN = "proxy-middleware-token";

describe("v402-proxy (full stack e2e)", () => {
  let facilitator: INestApplication;
  let storage: IStorage;
  let origin: http.Server;
  let proxy: http.Server;
  let proxyUrl: string;
  const originRequests: Array<{ method: string; url: string; body: string; headers: http.IncomingHttpHeaders }> = [];

  const paidFetch = () => wrapFetchWithPayment(fetch, { payer: PAYER, signer: new LocalKeySigner(KEY_A_WIF) });

  beforeAll(async () => {
    // real facilitator, listening on a real port
    // the facilitator MUST advertise the same canonicalDomain/payTo the
    // proxy advertises — it rebuilds the signed canonical from ITS config
    const config = buildConfig(
      { NODE_ENV: "test", FACILITATOR_AUTH_TOKEN: TOKEN, V402_PAY_TO: "originAPI@" },
      {
        db: { path: ":memory:" },
        logging: { level: "silent" },
        watcher: { mode: "simulated" },
        payment: { canonicalDomain: "origin.example.com" },
      },
    );
    const moduleRef = await Test.createTestingModule({ imports: [AppModule.forRoot(config)] })
      .overrideProvider(VERUS_RPC)
      .useValue(
        new MockVerusRpc({
          verifyMessage: async (_signer, signature, message) => signature === signAddressMessage(message, KEY_A_PRIV),
        }),
      )
      .compile();
    facilitator = moduleRef.createNestApplication();
    await facilitator.init();
    await facilitator.listen(0, "127.0.0.1");
    const facilitatorUrl = `http://127.0.0.1:${(facilitator.getHttpServer().address() as AddressInfo).port}`;
    storage = facilitator.get<IStorage>(STORAGE);

    const deposit = await storage.insertDeposit({
      identityId: PAYER_KEY,
      amountSats: 100_000_000n,
      currency: "VRSCTEST",
      txid: "proxy-fund",
      vout: 0,
      blockHeight: 1,
      blockHash: "h1",
      confirmations: 10,
      detectedAt: 1,
      origin: "real",
    });
    await storage.creditDeposit(deposit.id, 1);

    // dummy origin
    origin = http.createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (c: Buffer) => chunks.push(c));
      req.on("end", () => {
        originRequests.push({ method: req.method ?? "", url: req.url ?? "", body: Buffer.concat(chunks).toString(), headers: req.headers });
        if (req.url === "/api/boom") {
          res.writeHead(500, { "content-type": "application/json" });
          res.end('{"error":"origin exploded"}');
          return;
        }
        if (req.url?.startsWith("/api/stream")) {
          res.writeHead(200, { "content-type": "text/plain" });
          res.write("chunk-1;");
          setTimeout(() => res.end("chunk-2"), 20);
          return;
        }
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ origin: true, path: req.url }));
      });
    });
    await new Promise<void>((resolve) => origin.listen(0, "127.0.0.1", resolve));
    const originUrl = `http://127.0.0.1:${(origin.address() as AddressInfo).port}`;

    // the proxy under test
    const proxyConfig = buildProxyConfig(
      {
        V402_PROXY_UPSTREAM: originUrl,
        FACILITATOR_URL: facilitatorUrl,
        FACILITATOR_AUTH_TOKEN: TOKEN,
        V402_CANONICAL_DOMAIN: "origin.example.com",
        V402_NETWORK: "vrsctest",
        V402_ASSET: "VRSCTEST",
        V402_PAY_TO: "originAPI@",
      },
      {
        rules: [
          { match: "/api/health", free: true },
          { match: "/api/upload", method: "POST", price: "0.002", bodyHash: "required" },
          { match: "/api/*", price: "0.001" },
        ],
      },
    );
    proxy = createProxyServer(proxyConfig, { log: () => {} });
    await new Promise<void>((resolve) => proxy.listen(0, "127.0.0.1", resolve));
    proxyUrl = `http://127.0.0.1:${(proxy.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    await new Promise((resolve) => proxy.close(resolve));
    await new Promise((resolve) => origin.close(resolve));
    await facilitator.close();
  });

  it("passes unmatched routes through untouched", async () => {
    const response = await fetch(`${proxyUrl}/public/page?q=1`);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ origin: true, path: "/public/page?q=1" });
  });

  it("honors free-hole rules inside a priced prefix", async () => {
    const response = await fetch(`${proxyUrl}/api/health`);
    expect(response.status).toBe(200);
  });

  it("challenges priced routes with a 402 accepts envelope", async () => {
    const response = await fetch(`${proxyUrl}/api/data`);
    expect(response.status).toBe(402);
    const body = (await response.json()) as { accepts: Array<Record<string, unknown>> };
    expect(body.accepts[0]).toMatchObject({
      scheme: "verus-prepaid-sig",
      amount: "0.001",
      payTo: "originAPI@",
      canonicalDomain: "origin.example.com",
    });
  });

  it("pays a priced route end-to-end: exact debit, committed, forwarded verbatim", async () => {
    const before = (await storage.getIdentity(PAYER_KEY))!.balanceSats;
    const response = await paidFetch()(`${proxyUrl}/api/data?x=1`);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ origin: true, path: "/api/data?x=1" });

    const requestId = response.headers.get("x-v402-request-id")!;
    expect(requestId).toBeTruthy();
    // give the fire-after-response commit a beat
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect((await storage.getSpentRequest(requestId))?.status).toBe("committed");
    const after = (await storage.getIdentity(PAYER_KEY))!.balanceSats;
    expect(before - after).toBe(100_000n);
  });

  it("streams responses through and commits with the streamed byte count", async () => {
    const response = await paidFetch()(`${proxyUrl}/api/stream`);
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("chunk-1;chunk-2");
    const requestId = response.headers.get("x-v402-request-id")!;
    await new Promise((resolve) => setTimeout(resolve, 50));
    const row = await storage.getSpentRequest(requestId);
    expect(row?.status).toBe("committed");
    expect(row?.responseBytes).toBe("chunk-1;chunk-2".length);
  });

  it("rolls back when the origin answers 500", async () => {
    const before = (await storage.getIdentity(PAYER_KEY))!.balanceSats;
    const response = await paidFetch()(`${proxyUrl}/api/boom`);
    expect(response.status).toBe(500);
    const requestId = response.headers.get("x-v402-request-id")!;
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect((await storage.getSpentRequest(requestId))?.status).toBe("error");
    const after = (await storage.getIdentity(PAYER_KEY))!.balanceSats;
    expect(before).toBe(after); // refunded
  });

  it("enforces bodyHash=required and forwards the buffered body intact", async () => {
    const body = '{"file":"payload"}';
    const response = await paidFetch()(`${proxyUrl}/api/upload`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body,
    });
    expect(response.status).toBe(200);
    expect(originRequests.at(-1)).toMatchObject({ method: "POST", url: "/api/upload", body });
  });

  it("rejects oversized bodies on bodyHash routes with 413", async () => {
    const response = await fetch(`${proxyUrl}/api/upload`, {
      method: "POST",
      headers: { "x-v402-signature": "SGVsbG8=", "content-type": "application/octet-stream" },
      body: Buffer.alloc(2 * 1_048_576),
    });
    expect(response.status).toBe(413);
  });

  it("serves discovery with the rules-derived rate card and a health endpoint", async () => {
    const discovery = await fetch(`${proxyUrl}/.well-known/v402`);
    expect(discovery.status).toBe(200);
    const doc = (await discovery.json()) as Record<string, unknown>;
    expect(doc["endpoints"]).toEqual([
      { method: "POST", path: "/api/upload", amount: "0.002", amountUnit: "human", asset: "VRSCTEST", bodyHashPolicy: "required" },
      { method: "*", path: "/api/*", amount: "0.001", amountUnit: "human", asset: "VRSCTEST", bodyHashPolicy: "ignored" },
    ]);
    expect((await fetch(`${proxyUrl}/.well-known/v402/health`)).status).toBe(200);
  });

  it("maps an unreachable facilitator to 503 verify-unavailable", async () => {
    const unreachable = buildProxyConfig(
      {
        V402_PROXY_UPSTREAM: "http://127.0.0.1:1",
        FACILITATOR_URL: "http://127.0.0.1:1",
        FACILITATOR_AUTH_TOKEN: "x",
        V402_CANONICAL_DOMAIN: "origin.example.com",
        V402_NETWORK: "vrsctest",
        V402_ASSET: "VRSCTEST",
        V402_PAY_TO: "originAPI@",
      },
      { rules: [{ match: "/api/*", price: "0.001" }] },
    );
    const broken = createProxyServer(unreachable, { log: () => {} });
    await new Promise<void>((resolve) => broken.listen(0, "127.0.0.1", resolve));
    const port = (broken.address() as AddressInfo).port;
    try {
      const response = await fetch(`http://127.0.0.1:${port}/api/data`, {
        headers: { "x-v402-signature": "SGVsbG8=" },
      });
      expect(response.status).toBe(503);
      const body = (await response.json()) as { error: { code: string } };
      expect(body.error.code).toBe("verify-unavailable");
    } finally {
      await new Promise((resolve) => broken.close(resolve));
    }
  });
});
