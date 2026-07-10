import { describe, expect, it } from "vitest";
import { MockVerusRpc, VerusRpcClient, VerusRpcError, VerusRpcUnavailableError } from "../src/index.js";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

interface StubState {
  calls: Array<{ url: string; body: Record<string, unknown>; authorization: string | null }>;
}

function makeClient(
  handler: (call: { method: string; params: unknown[] }) => Response | Promise<Response>,
  circuit?: { timeoutMs?: number; failuresBeforeOpen?: number; recoveryMs?: number },
): { client: VerusRpcClient; state: StubState } {
  const state: StubState = { calls: [] };
  const fetchImpl: typeof fetch = async (url, init) => {
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    const headers = new Headers(init?.headers);
    state.calls.push({ url: String(url), body, authorization: headers.get("authorization") });
    return handler({ method: body["method"] as string, params: body["params"] as unknown[] });
  };
  const client = new VerusRpcClient({
    rpcUrl: "http://node.test:18843",
    rpcUser: "user",
    rpcPass: "pass",
    circuit: { timeoutMs: 100, failuresBeforeOpen: 3, recoveryMs: 60_000, ...circuit },
    fetchImpl,
  });
  return { client, state };
}

describe("VerusRpcClient — request shape", () => {
  it("sends JSON-RPC 1.0 with basic auth and returns the result", async () => {
    const { client, state } = makeClient(() => jsonResponse({ result: 1140451, error: null }));
    await expect(client.getBlockCount()).resolves.toBe(1140451);
    expect(state.calls).toHaveLength(1);
    expect(state.calls[0]!.authorization).toBe("Basic " + Buffer.from("user:pass").toString("base64"));
    expect(state.calls[0]!.body).toMatchObject({ jsonrpc: "1.0", method: "getblockcount", params: [] });
  });

  it("stringifies block heights (verusd expects strings)", async () => {
    const { client, state } = makeClient(() => jsonResponse({ result: { hash: "00", height: 5, time: 1, tx: [] } }));
    await client.getBlock(5);
    expect(state.calls[0]!.body["params"]).toEqual(["5", 1]);
  });

  it("passes verifymessage params in daemon order", async () => {
    const { client, state } = makeClient(() => jsonResponse({ result: true }));
    await expect(client.verifyMessage("fum@", "c2ln", "msg")).resolves.toBe(true);
    expect(state.calls[0]!.body["params"]).toEqual(["fum@", "c2ln", "msg"]);
  });

  it("forwards checkLatest as the daemon's 4th verifymessage param", async () => {
    const { client, state } = makeClient(() => jsonResponse({ result: true }));
    await client.verifyMessage("fum@", "c2ln", "msg", true);
    expect(state.calls[0]!.body["params"]).toEqual(["fum@", "c2ln", "msg", true]);
  });
});

describe("VerusRpcClient — error taxonomy", () => {
  it("maps a JSON-RPC error body (HTTP 500, bitcoin-style) to VerusRpcError with code", async () => {
    const { client } = makeClient(() =>
      jsonResponse({ result: null, error: { code: -5, message: "Invalid identity" } }, 500),
    );
    const err = await client.getIdentity("nope@").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(VerusRpcError);
    expect((err as VerusRpcError).code).toBe(-5);
    expect((err as VerusRpcError).method).toBe("getidentity");
  });

  it("maps network failures to VerusRpcUnavailableError(network)", async () => {
    const { client } = makeClient(() => {
      throw new TypeError("fetch failed");
    });
    const err = await client.getInfo().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(VerusRpcUnavailableError);
    expect((err as VerusRpcUnavailableError).reason).toBe("network");
  });

  it("maps non-JSON responses to VerusRpcUnavailableError(bad-response)", async () => {
    const { client } = makeClient(() => new Response("<html>proxy error</html>", { status: 502 }));
    const err = await client.getInfo().catch((e: unknown) => e);
    expect((err as VerusRpcUnavailableError).reason).toBe("bad-response");
  });

  it("times out slow calls (aggressive strategy)", async () => {
    const { client } = makeClient(() => new Promise<Response>(() => {}), { timeoutMs: 25 });
    const err = await client.getInfo().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(VerusRpcUnavailableError);
    expect((err as VerusRpcUnavailableError).reason).toBe("timeout");
  });
});

describe("VerusRpcClient — circuit breaker", () => {
  it("opens after N consecutive unavailability failures and fails fast without touching the node", async () => {
    const { client, state } = makeClient(() => {
      throw new TypeError("fetch failed");
    });
    for (let i = 0; i < 3; i++) {
      const err = await client.getInfo().catch((e: unknown) => e);
      expect((err as VerusRpcUnavailableError).reason).toBe("network");
    }
    expect(client.circuitState()).toBe("open");
    const err = await client.getInfo().catch((e: unknown) => e);
    expect((err as VerusRpcUnavailableError).reason).toBe("circuit-open");
    expect(state.calls).toHaveLength(3); // 4th call never reached the transport
  });

  it("does NOT count JSON-RPC app errors as failures (malformed-input spam cannot trip it)", async () => {
    let healthy = false;
    const { client } = makeClient(() =>
      healthy
        ? jsonResponse({ result: true })
        : jsonResponse({ result: null, error: { code: -5, message: "Malformed base64 encoding" } }, 500),
    );
    for (let i = 0; i < 10; i++) {
      await expect(client.verifyMessage("a@", "!!", "m")).rejects.toBeInstanceOf(VerusRpcError);
    }
    expect(client.circuitState()).toBe("closed");
    healthy = true;
    await expect(client.verifyMessage("a@", "c2ln", "m")).resolves.toBe(true);
  });
});

describe("MockVerusRpc", () => {
  it("delegates stubbed methods and records calls", async () => {
    const mock = new MockVerusRpc({ verifyMessage: async () => true });
    await expect(mock.verifyMessage("a@", "sig", "msg")).resolves.toBe(true);
    expect(mock.calls).toEqual([{ method: "verifyMessage", params: ["a@", "sig", "msg"] }]);
  });

  it("rejects unstubbed methods with a clear error", async () => {
    const mock = new MockVerusRpc();
    await expect(mock.getBlockCount()).rejects.toThrow("getBlockCount not stubbed");
  });
});
