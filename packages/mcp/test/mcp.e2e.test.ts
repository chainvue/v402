/**
 * Full-stack e2e: MCP client ↔ v402 MCP server (InMemory transport) with a
 * REAL guarded API (NestJS adapter, in-process verifier, cryptographically
 * real signature checks) and a REAL facilitator (balance/topup/discovery).
 * This is the "Claude pays for an API mid-conversation" demo, as a test.
 */
import "reflect-metadata";
import type { AddressInfo } from "node:net";
import { Controller, Get, Module } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import type { INestApplication } from "@nestjs/common";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { AppModule, STORAGE, VERUS_RPC, buildConfig } from "@chainvue/v402-facilitator";
import { V402Module, V402Payment } from "@chainvue/v402-nestjs";
import type { IStorage } from "@chainvue/v402-storage";
import { InMemoryStorage } from "@chainvue/v402-storage";
import { MockVerusRpc } from "@chainvue/v402-verus-rpc";
import { decodeWif, signAddressMessage } from "@chainvue/v402-signer-verus";
import { buildMcpServer } from "../src/index.js";

const KEY_A_WIF = "Uw81VDAH8zrvbGJLfo1nfLaWN9tnGMo2U3bB81Zg8MKBvakrNXqP";
const KEY_A_PRIV = decodeWif(KEY_A_WIF);
const PAYER = "v402test.demoAgent@";
const PAYER_KEY = "v402test.demoagent@";

@Controller()
class DemoApi {
  @Get("free")
  free(): unknown {
    return { free: true };
  }

  @Get("api/report")
  @V402Payment("0.001")
  report(): unknown {
    return { report: "paid content" };
  }

  @Get("api/premium")
  @V402Payment("0.05")
  premium(): unknown {
    return { premium: true };
  }
}

async function fund(storage: IStorage, txid: string, sats: bigint): Promise<void> {
  const deposit = await storage.insertDeposit({
    identityId: PAYER_KEY,
    amountSats: sats,
    currency: "VRSCTEST",
    txid,
    vout: 0,
    blockHeight: 1,
    blockHash: "h1",
    confirmations: 10,
    detectedAt: 1,
    origin: "real",
  });
  await storage.creditDeposit(deposit.id, 1);
}

describe("v402 MCP server (full stack e2e)", () => {
  let demoApp: INestApplication;
  let facilitator: INestApplication;
  let demoStorage: InMemoryStorage;
  let demoUrl: string;
  let facilitatorUrl: string;

  beforeAll(async () => {
    const verify = new MockVerusRpc({
      verifyMessage: async (_signer, signature, message) => signature === signAddressMessage(message, KEY_A_PRIV),
    });

    // guarded demo API (in-process verifier, real crypto via the mock's recompute)
    demoStorage = new InMemoryStorage();
    await demoStorage.initialize();
    await fund(demoStorage, "mcp-demo-fund", 10_000_000n);

    @Module({
      imports: [
        V402Module.forRoot({
          canonicalDomain: "demo.example.com",
          network: "vrsctest",
          asset: "VRSCTEST",
          payTo: "demoAPI@",
          facilitatorUrl: "http://facilitator.local",
          db: { path: ":memory:" },
          verus: { rpcUrl: "http://unused", rpcUser: "", rpcPass: "" },
          storage: demoStorage,
          verusRpc: verify,
        }),
      ],
      controllers: [DemoApi],
    })
    class DemoAppModule {}
    demoApp = (await Test.createTestingModule({ imports: [DemoAppModule] }).compile()).createNestApplication();
    await demoApp.init();
    await demoApp.listen(0, "127.0.0.1");
    demoUrl = `http://127.0.0.1:${(demoApp.getHttpServer().address() as AddressInfo).port}`;

    // real facilitator for balance/topup/discovery
    const config = buildConfig(
      { NODE_ENV: "test", FACILITATOR_AUTH_TOKEN: "mcp-token" },
      { db: { path: ":memory:" }, logging: { level: "silent" }, watcher: { mode: "simulated" } },
    );
    facilitator = (
      await Test.createTestingModule({ imports: [AppModule.forRoot(config)] })
        .overrideProvider(VERUS_RPC)
        .useValue(verify)
        .compile()
    ).createNestApplication();
    await facilitator.init();
    await facilitator.listen(0, "127.0.0.1");
    facilitatorUrl = `http://127.0.0.1:${(facilitator.getHttpServer().address() as AddressInfo).port}`;
    await fund(facilitator.get<IStorage>(STORAGE), "mcp-facilitator-fund", 200_000_000n);
  });

  afterAll(async () => {
    await demoApp.close();
    await facilitator.close();
  });

  async function connect(overrides: Record<string, unknown> = {}) {
    const server = buildMcpServer({
      facilitator: facilitatorUrl,
      identity: PAYER,
      signingKey: KEY_A_WIF,
      ...overrides,
    });
    const client = new Client({ name: "test-host", version: "0.0.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    return { client, server };
  }

  function firstText(result: unknown): string {
    const content = (result as { content: Array<{ type: string; text: string }> }).content;
    return content[0]!.text;
  }

  it("lists the four v402 tools", async () => {
    const { client } = await connect();
    const tools = await client.listTools();
    expect(tools.tools.map((t) => t.name).sort()).toEqual([
      "v402_balance",
      "v402_discover",
      "v402_paid_fetch",
      "v402_topup_instructions",
    ]);
  });

  it("fetches free URLs without paying", async () => {
    const { client } = await connect();
    const result = await client.callTool({ name: "v402_paid_fetch", arguments: { url: `${demoUrl}/free` } });
    const payload = JSON.parse(firstText(result)) as Record<string, unknown>;
    expect(payload["status"]).toBe(200);
    expect(payload["paid"]).toBeNull();
  });

  it("pays a priced URL end-to-end: exact debit, committed, spend tracked", async () => {
    const before = (await demoStorage.getIdentity(PAYER_KEY))!.balanceSats;
    const { client } = await connect();
    const result = await client.callTool({ name: "v402_paid_fetch", arguments: { url: `${demoUrl}/api/report` } });
    const payload = JSON.parse(firstText(result)) as Record<string, unknown>;
    expect(payload["status"]).toBe(200);
    expect(payload["paid"]).toEqual({ amount: "0.001", asset: "VRSCTEST" });
    expect(payload["sessionSpent"]).toBe("0.001");
    expect(JSON.parse(payload["body"] as string)).toEqual({ report: "paid content" });

    expect((await demoStorage.getSpentRequest(payload["requestId"] as string))?.status).toBe("committed");
    const after = (await demoStorage.getIdentity(PAYER_KEY))!.balanceSats;
    expect(before - after).toBe(100_000n);
  });

  it("refuses prices above the per-request cap BEFORE paying", async () => {
    const before = (await demoStorage.getIdentity(PAYER_KEY))!.balanceSats;
    const { client } = await connect({ maxPerRequestSats: 1_000_000n }); // 0.01
    const result = await client.callTool({ name: "v402_paid_fetch", arguments: { url: `${demoUrl}/api/premium` } });
    expect(result.isError).toBe(true);
    expect(firstText(result)).toContain("per-request cap");
    expect((await demoStorage.getIdentity(PAYER_KEY))!.balanceSats).toBe(before); // nothing spent
  });

  it("enforces the cumulative session cap", async () => {
    const { client } = await connect({ maxTotalSats: 150_000n }); // 0.0015 — one 0.001 call fits, two don't
    const first = await client.callTool({ name: "v402_paid_fetch", arguments: { url: `${demoUrl}/api/report` } });
    expect(JSON.parse(firstText(first))["status"]).toBe(200);
    const second = await client.callTool({ name: "v402_paid_fetch", arguments: { url: `${demoUrl}/api/report` } });
    expect(second.isError).toBe(true);
    expect(firstText(second)).toContain("total cap");
  });

  it("enforces the host allowlist", async () => {
    const { client } = await connect({ allowedHosts: ["api.somewhere-else.example"] });
    const result = await client.callTool({ name: "v402_paid_fetch", arguments: { url: `${demoUrl}/api/report` } });
    expect(result.isError).toBe(true);
    expect(firstText(result)).toContain("allowlist");
  });

  it("reports the balance from the facilitator", async () => {
    const { client } = await connect();
    const result = await client.callTool({ name: "v402_balance", arguments: {} });
    const balance = JSON.parse(firstText(result)) as Record<string, unknown>;
    expect(balance["balanceSats"]).toBe("200000000");
  });

  it("serves topup instructions and discovery", async () => {
    const { client } = await connect();
    const topup = JSON.parse(firstText(await client.callTool({ name: "v402_topup_instructions", arguments: { amount: "5" } }))) as Record<string, unknown>;
    expect(topup["instructions"]).toBeDefined();

    const discovery = JSON.parse(
      firstText(await client.callTool({ name: "v402_discover", arguments: { baseUrl: demoUrl } })),
    ) as Record<string, unknown>;
    const endpoints = discovery["endpoints"] as Array<Record<string, unknown>>;
    expect(endpoints.map((e) => e["path"]).sort()).toEqual(["/api/premium", "/api/report"]);
  });
});
