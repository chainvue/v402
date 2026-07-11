import { describe, expect, it } from "vitest";
import { HttpFacilitatorVerifier } from "../src/index.js";

interface Captured {
  url: string;
  authorization: string | null;
  body: Record<string, unknown>;
}

function makeVerifier(
  handler: (captured: Captured) => { status: number; body: unknown } | Promise<never>,
): { verifier: HttpFacilitatorVerifier; calls: Captured[] } {
  const calls: Captured[] = [];
  const fetchImpl: typeof fetch = async (url, init) => {
    const captured: Captured = {
      url: String(url),
      authorization: new Headers(init?.headers).get("authorization"),
      body: JSON.parse(String(init?.body)) as Record<string, unknown>,
    };
    calls.push(captured);
    const result = await handler(captured);
    return new Response(JSON.stringify(result.body), { status: result.status });
  };
  const verifier = new HttpFacilitatorVerifier({
    scheme: "verus-prepaid-sig",
    baseUrl: "http://facilitator:3000/",
    authToken: "mw-token",
    middlewareId: "demo",
    fetchImpl,
  });
  return { verifier, calls };
}

const REQUEST = {
  method: "POST",
  path: "/graphql",
  headers: { "x-v402-payer": "a@" },
  rawBody: Buffer.from("{}"),
};
const POLICY = { priceHuman: "0.001", bodyHashPolicy: "required" as const };

describe("HttpFacilitatorVerifier", () => {
  it("posts the payment body with Basic auth and maps a successful reserve", async () => {
    const { verifier, calls } = makeVerifier(() => ({
      status: 201,
      body: { ok: true, requestId: "01A", payer: "a@", amountSats: "100000", balanceAfterSats: "50000" },
    }));
    const result = await verifier.verifyAndReserve(REQUEST, POLICY);
    expect(result).toEqual({ ok: true, requestId: "01A", payer: "a@", amountSats: 100_000n, balanceAfterSats: 50_000n });
    expect(calls[0]!.url).toBe("http://facilitator:3000/v1/reserve"); // trailing slash normalized
    expect(calls[0]!.authorization).toBe("Basic " + Buffer.from("demo:mw-token").toString("base64"));
    expect(calls[0]!.body).toMatchObject({
      method: "POST",
      path: "/graphql",
      rawBodyBase64: Buffer.from("{}").toString("base64"),
      policy: POLICY,
    });
  });

  it("maps remote errors onto VerifyError with the response status", async () => {
    const { verifier } = makeVerifier(() => ({
      status: 409,
      body: { ok: false, error: { code: "replay", message: "requestId already spent", details: { previousStatus: "committed" } } },
    }));
    const result = await verifier.verifyAndReserve(REQUEST, POLICY);
    expect(!result.ok && result.error).toEqual({
      httpStatus: 409,
      code: "replay",
      message: "requestId already spent",
      details: { previousStatus: "committed" },
    });
  });

  it("maps network failures to 503 verify-unavailable (M5: same-requestId retry safe)", async () => {
    const { verifier } = makeVerifier(() => {
      throw new TypeError("fetch failed");
    });
    const result = await verifier.verify(REQUEST, POLICY);
    expect(!result.ok && result.error).toMatchObject({ httpStatus: 503, code: "verify-unavailable" });
  });

  it("maps commit and rollback results incl. late-commit balances", async () => {
    const { verifier, calls } = makeVerifier((captured) =>
      captured.url.endsWith("/v1/commit")
        ? { status: 201, body: { ok: true, alreadyCommitted: false, late: true, balanceAfterSats: "-5" } }
        : { status: 201, body: { ok: true, alreadyRolledBack: true } },
    );
    expect(await verifier.commit("01A", 42)).toEqual({
      ok: true,
      alreadyCommitted: false,
      late: true,
      balanceAfterSats: -5n,
    });
    expect(calls[0]!.body).toEqual({ requestId: "01A", responseBytes: 42, scheme: "verus-prepaid-sig" });
    expect(await verifier.rollback("01A")).toEqual({ ok: true, alreadyRolledBack: true });
  });
});
