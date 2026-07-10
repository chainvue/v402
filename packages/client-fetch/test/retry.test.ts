import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { LocalKeySigner } from "@chainvue/v402-signer-verus";
import { V402Client, facilitatorHeightProvider, wrapFetchWithPayment } from "../src/index.js";

const KEY_A_WIF = "Uw81VDAH8zrvbGJLfo1nfLaWN9tnGMo2U3bB81Zg8MKBvakrNXqP";
const PAYER = "v402.demoAgent@";

function requirement(amount: string): Record<string, unknown> {
  return {
    scheme: "verus-prepaid-sig",
    schemeVersion: "0.1",
    network: "vrsctest",
    asset: "VRSCTEST",
    amount,
    amountUnit: "human",
    payTo: "explorerAPI@",
    facilitator: "http://facilitator.local",
    requiredHeaders: ["X-V402-Scheme", "X-V402-Payer", "X-V402-Amount", "X-V402-Request-Id", "X-V402-Issued-At", "X-V402-Signature"],
    canonicalDomain: "scripted.example.com",
  };
}

interface Seen {
  requestId: string | undefined;
  signature: string | undefined;
  amount: string | undefined;
  scheme: string | undefined;
}

type Script = (paidAttempt: number, seen: Seen, res: ServerResponse) => void;

/** Minimal scripted origin: unpaid requests get a 402 challenge; paid attempts run the script. */
function scriptedServer(challengeAmount: string, script: Script): Promise<{ server: Server; url: string; seenLog: Seen[] }> {
  const seenLog: Seen[] = [];
  let paidAttempt = 0;
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const seen: Seen = {
      requestId: req.headers["x-v402-request-id"] as string | undefined,
      signature: req.headers["x-v402-signature"] as string | undefined,
      amount: req.headers["x-v402-amount"] as string | undefined,
      scheme: req.headers["x-v402-scheme"] as string | undefined,
    };
    if (seen.requestId === undefined) {
      res.writeHead(402, { "content-type": "application/json" });
      res.end(JSON.stringify({ version: "v402/0.1", accepts: [requirement(challengeAmount)] }));
      return;
    }
    seenLog.push(seen);
    script(paidAttempt++, seen, res);
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as AddressInfo;
      resolve({ server, url: `http://127.0.0.1:${port}`, seenLog });
    });
  });
}

function json(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  res.writeHead(status, { "content-type": "application/json", ...headers });
  res.end(JSON.stringify(body));
}

describe("M5 retry semantics against a scripted origin", () => {
  const servers: Server[] = [];
  afterEach(() => {
    for (const server of servers.splice(0)) server.close();
  });

  function client(overrides: Record<string, unknown> = {}): typeof fetch {
    return wrapFetchWithPayment(fetch, {
      payer: PAYER,
      signer: new LocalKeySigner(KEY_A_WIF),
      sleep: async () => {},
      ...overrides,
    });
  }

  it("recovers from price-mismatch with a FRESH ulid signed at the new price (M6)", async () => {
    const { server, url, seenLog } = await scriptedServer("0.002", (attempt, seen, res) => {
      if (attempt === 0) {
        json(res, 402, {
          version: "v402/0.1",
          error: { code: "price-mismatch", message: "price changed" },
          accepts: [requirement("0.001")],
        });
        return;
      }
      json(res, 200, { ok: true, paidAmount: seen.amount });
    });
    servers.push(server);

    const response = await client()(`${url}/api/x`);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, paidAmount: "0.001" });
    expect(seenLog).toHaveLength(2);
    expect(seenLog[0]!.amount).toBe("0.002");
    expect(seenLog[1]!.amount).toBe("0.001");
    expect(seenLog[0]!.requestId).not.toBe(seenLog[1]!.requestId); // fresh ULID
  });

  it("sends X-V402-Scheme as <scheme>/<schemeVersion> — the signed payload line 1 (D1)", async () => {
    const { server, url, seenLog } = await scriptedServer("0.001", (_attempt, _seen, res) => {
      json(res, 200, { ok: true });
    });
    servers.push(server);

    const response = await client()(`${url}/api/x`);
    expect(response.status).toBe(200);
    expect(seenLog[0]!.scheme).toBe("verus-prepaid-sig/0.1");
  });

  it("retries 503 with the SAME requestId and the SAME signature", async () => {
    const { server, url, seenLog } = await scriptedServer("0.001", (attempt, _seen, res) => {
      if (attempt < 2) {
        json(res, 503, { error: { code: "verify-unavailable" } }, { "retry-after": "0" });
        return;
      }
      json(res, 200, { ok: true });
    });
    servers.push(server);

    const response = await client()(`${url}/api/x`);
    expect(response.status).toBe(200);
    expect(seenLog).toHaveLength(3);
    expect(new Set(seenLog.map((s) => s.requestId)).size).toBe(1); // same id — no double-pay risk
    expect(new Set(seenLog.map((s) => s.signature)).size).toBe(1);
  });

  it("honors Retry-After on 429 (capped) and retries with the same id", async () => {
    const sleeps: number[] = [];
    const { server, url, seenLog } = await scriptedServer("0.001", (attempt, _seen, res) => {
      if (attempt === 0) {
        json(res, 429, { error: "slow down" }, { "retry-after": "3" });
        return;
      }
      json(res, 200, { ok: true });
    });
    servers.push(server);

    const response = await client({
      sleep: async (ms: number) => {
        sleeps.push(ms);
      },
      maxRetryAfterMs: 1500,
    })(`${url}/api/x`);
    expect(response.status).toBe(200);
    expect(sleeps).toEqual([1500]); // 3s requested, capped
    expect(new Set(seenLog.map((s) => s.requestId)).size).toBe(1);
  });

  it("retries socket-level failures with the same id, then surfaces retries-exhausted", async () => {
    const { server, url, seenLog } = await scriptedServer("0.001", (_attempt, _seen, res) => {
      res.destroy(); // hard network failure on every paid attempt
    });
    servers.push(server);

    await expect(client({ maxRetries: 2 })(`${url}/api/x`)).rejects.toMatchObject({
      name: "V402ClientError",
      code: "retries-exhausted",
    });
    expect(seenLog).toHaveLength(3); // 1 + 2 retries, all same id
    expect(new Set(seenLog.map((s) => s.requestId)).size).toBe(1);
  });

  it("returns 409 replay responses to the caller — that IS the answer (M5)", async () => {
    const { server, url } = await scriptedServer("0.001", (_attempt, _seen, res) => {
      json(res, 409, { error: { code: "replay", details: { previousStatus: "committed" } } });
    });
    servers.push(server);

    const response = await client()(`${url}/api/x`);
    expect(response.status).toBe(409);
    const body = (await response.json()) as { error: { details: { previousStatus: string } } };
    expect(body.error.details.previousStatus).toBe("committed");
  });

  it("gives up on price-mismatch loops after the configured recoveries", async () => {
    const { server, url, seenLog } = await scriptedServer("0.002", (_attempt, _seen, res) => {
      json(res, 402, { version: "v402/0.1", error: { code: "price-mismatch" }, accepts: [requirement("0.003")] });
    });
    servers.push(server);

    const response = await client({ priceMismatchRetries: 2 })(`${url}/api/x`);
    expect(response.status).toBe(402); // surfaced, not looped forever
    expect(seenLog).toHaveLength(3); // initial + 2 recoveries
  });
});

describe("V402Client facilitator conveniences against a scripted facilitator", () => {
  const servers: Server[] = [];
  afterEach(() => {
    for (const server of servers.splice(0)) server.close();
  });

  async function scriptedFacilitator(): Promise<string> {
    const server = createServer((req, res) => {
      if (req.url === "/.well-known/v402") {
        json(res, 200, {
          canonicalDomain: "facilitator.example.com",
          network: "vrsctest",
          supportedVersions: ["v402/0.1"],
          defaultVersion: "v402/0.1",
        });
      } else if (req.url?.startsWith("/v1/balance")) {
        // signature presence is asserted; verification is the facilitator suite's job
        if (req.headers["x-v402-signature"] === undefined) {
          json(res, 400, { error: { code: "invalid-headers" } });
          return;
        }
        json(res, 200, {
          identity: "v402.demoagent@",
          balance: "1",
          reserved: "0",
          available: "1",
          balanceSats: "100000000",
          reservedSats: "0",
          availableSats: "100000000",
        });
      } else if (req.url?.startsWith("/v1/topup-instructions")) {
        json(res, 200, { instructions: { paymentUri: `verus://send?x=1&url=${req.url}` } });
      } else if (req.url === "/v1/health") {
        json(res, 200, { status: "ok", verusRpc: { reachable: true, blocks: 1_140_465 } });
      } else {
        json(res, 404, {});
      }
    });
    return new Promise((resolve) => {
      server.listen(0, "127.0.0.1", () => {
        servers.push(server);
        resolve(`http://127.0.0.1:${(server.address() as AddressInfo).port}`);
      });
    });
  }

  it("getBalance signs the domain-separated query using discovery data", async () => {
    const facilitator = await scriptedFacilitator();
    const client = new V402Client({ identity: PAYER, signer: new LocalKeySigner(KEY_A_WIF), facilitator });
    const balance = await client.getBalance();
    expect(balance.balanceSats).toBe("100000000");
  });

  it("getTopupInstructions passes identity and amount through", async () => {
    const facilitator = await scriptedFacilitator();
    const client = new V402Client({ identity: PAYER, signer: new LocalKeySigner(KEY_A_WIF), facilitator });
    const topup = (await client.getTopupInstructions({ amount: "5" })) as {
      instructions: { paymentUri: string };
    };
    expect(topup.instructions.paymentUri).toContain("identity=v402.demoAgent%40");
    expect(topup.instructions.paymentUri).toContain("amount=5");
  });

  it("facilitatorHeightProvider reads the chain height from health", async () => {
    const facilitator = await scriptedFacilitator();
    expect(await facilitatorHeightProvider(facilitator)()).toBe(1_140_465);
  });
});
