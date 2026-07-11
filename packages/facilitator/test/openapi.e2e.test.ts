/**
 * Anti-drift gate for spec/0.1/facilitator-api.openapi.yaml: boots the real
 * facilitator and validates ACTUAL responses of every documented JSON
 * endpoint against the OpenAPI response schemas. If a controller and the
 * OpenAPI document disagree, this suite fails — the document cannot silently
 * drift from the implementation (the failure mode the markdown guides
 * already suffered once, see docs/RISKS.md Layer 7).
 */
import "reflect-metadata";
import { readFileSync } from "node:fs";
import { Test } from "@nestjs/testing";
import type { INestApplication } from "@nestjs/common";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Ajv2020 } from "ajv/dist/2020.js";
import { parse as parseYaml } from "yaml";
import type { IStorage } from "@chainvue/v402-storage";
import { MockVerusRpc, VerusRpcError } from "@chainvue/v402-verus-rpc";
import { AppModule } from "../src/app.module.js";
import { buildConfig } from "../src/config/schema.js";
import { STORAGE, VERUS_RPC } from "../src/core/core.module.js";

const TOKEN = "test-middleware-token";
const ADMIN_TOKEN = "test-admin-token";
const PAYER = "v402test.demoAgent@";
const PAYER_KEY = "v402test.demoagent@";
const ISSUED_AT = Math.floor(Date.now() / 1000);
/** Valid 26-char Crockford-base32 ULIDs (no I/L/O/U) per 2-char suffix. */
const rid = (suffix: string) => `01H8XG7Q4M2N8P5R7T3V9WXY${suffix}`;

const openapi = parseYaml(
  readFileSync(new URL("../../../spec/0.1/facilitator-api.openapi.yaml", import.meta.url), "utf8"),
) as Record<string, unknown>;

// strict:false — OpenAPI documents carry non-JSON-Schema keywords (paths,
// info, …) that ajv would otherwise reject when resolving $refs through them
const ajv = new Ajv2020({ strict: false, allErrors: true });
ajv.addSchema(openapi, "openapi");

/** Compile the response schema for (path, method, status) out of the document. */
function responseValidator(path: string, method: string, status: string, contentType = "application/json") {
  const escaped = path.replace(/~/g, "~0").replace(/\//g, "~1");
  const paths = openapi["paths"] as Record<string, Record<string, { responses: Record<string, unknown> }>>;
  let response = paths[path]?.[method]?.responses[status] as { $ref?: string } | undefined;
  let pointer = `openapi#/paths/${escaped}/${method}/responses/${status}`;
  if (response === undefined) {
    response = paths[path]?.[method]?.responses["default"] as { $ref?: string } | undefined;
    pointer = `openapi#/paths/${escaped}/${method}/responses/default`;
  }
  if (response === undefined) throw new Error(`no ${status}/default response documented for ${method} ${path}`);
  if (response.$ref !== undefined) pointer = `openapi#${response.$ref.slice(1)}`;
  const ct = contentType.replace(/~/g, "~0").replace(/\//g, "~1");
  return ajv.compile({ $ref: `${pointer}/content/${ct}/schema` });
}

/** Assert body validates against the documented schema for this response. */
function expectDocumented(path: string, method: string, status: number, body: unknown): void {
  const validate = responseValidator(path, method, String(status));
  const valid = validate(body);
  if (!valid) {
    throw new Error(
      `${method.toUpperCase()} ${path} → ${status} does not match the OpenAPI document:\n` +
        `${JSON.stringify(validate.errors, null, 2)}\nbody: ${JSON.stringify(body, null, 2)}`,
    );
  }
  expect(valid).toBe(true);
}

function paymentBody(requestId: string) {
  return {
    method: "GET",
    path: "/api/tx/abc",
    headers: {
      "x-v402-scheme": "verus-prepaid-sig",
      "x-v402-payer": PAYER,
      "x-v402-amount": "0.001",
      "x-v402-request-id": requestId,
      "x-v402-issued-at": String(ISSUED_AT),
      "x-v402-signature": "SGVsbG8rL3dvcmxkQUJDRA==",
    },
    policy: { priceHuman: "0.001", bodyHashPolicy: "optional" },
  };
}

describe("OpenAPI document matches the implementation (e2e)", () => {
  let app: INestApplication;
  let storage: IStorage;

  beforeAll(async () => {
    const config = buildConfig(
      { NODE_ENV: "test", FACILITATOR_AUTH_TOKEN: TOKEN, V402_ADMIN_TOKEN: ADMIN_TOKEN },
      { db: { path: ":memory:" }, logging: { level: "silent" }, watcher: { mode: "simulated" } },
    );
    const rpc = new MockVerusRpc({
      verifyMessage: async () => true,
      getInfo: async () => ({ VRSCversion: "1.2.17", version: 1, name: "VRSCTEST", blocks: 1_140_000, chainid: "x" }),
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
    const moduleRef = await Test.createTestingModule({ imports: [AppModule.forRoot(config)] })
      .overrideProvider(VERUS_RPC)
      .useValue(rpc)
      .compile();
    app = moduleRef.createNestApplication();
    await app.init();
    storage = app.get<IStorage>(STORAGE);

    const deposit = await storage.insertDeposit({
      identityId: PAYER_KEY,
      amountSats: 10_000_000n,
      currency: "VRSCTEST",
      txid: "openapi-fund",
      vout: 0,
      blockHeight: 1,
      blockHash: "h1",
      confirmations: 10,
      detectedAt: ISSUED_AT,
      origin: "real",
    });
    await storage.creditDeposit(deposit.id, ISSUED_AT);
  });

  afterAll(async () => {
    await app.close();
  });

  const server = () => app.getHttpServer();
  const authed = () => ({ user: "middleware-1", pass: TOKEN });

  it("GET /.well-known/v402", async () => {
    const res = await request(server()).get("/.well-known/v402").expect(200);
    expectDocumented("/.well-known/v402", "get", 200, res.body);
  });

  it("GET /v1/topup-instructions", async () => {
    const res = await request(server()).get("/v1/topup-instructions").query({ identity: PAYER, amount: "5" }).expect(200);
    expectDocumented("/v1/topup-instructions", "get", 200, res.body);
  });

  it("GET /v1/health", async () => {
    const res = await request(server()).get("/v1/health");
    expect([200, 503]).toContain(res.status);
    expectDocumented("/v1/health", "get", res.status, res.body);
  });

  it("GET /v1/balance (signature-authenticated)", async () => {
    const res = await request(server())
      .get("/v1/balance")
      .set({
        "x-v402-payer": PAYER,
        "x-v402-request-id": rid("ZA"),
        "x-v402-issued-at": String(ISSUED_AT),
        "x-v402-signature": "SGVsbG8rL3dvcmxkQUJDRA==",
      })
      .expect(200);
    expectDocumented("/v1/balance", "get", 200, res.body);
  });

  it("POST /v1/verify (201) and its error envelope (402)", async () => {
    const { user, pass } = authed();
    const ok = await request(server()).post("/v1/verify").auth(user, pass).send(paymentBody(rid("ZB"))).expect(201);
    expectDocumented("/v1/verify", "post", 201, ok.body);

    const bad = await request(server())
      .post("/v1/verify")
      .auth(user, pass)
      .send({ ...paymentBody(rid("ZC")), policy: { priceHuman: "0.002", bodyHashPolicy: "optional" } })
      .expect(402);
    expectDocumented("/v1/verify", "post", 402, bad.body);
  });

  it("POST /v1/reserve → commit lifecycle (201, 409 replay, 201 commit)", async () => {
    const { user, pass } = authed();
    const requestId = rid("ZD");
    const reserved = await request(server()).post("/v1/reserve").auth(user, pass).send(paymentBody(requestId)).expect(201);
    expectDocumented("/v1/reserve", "post", 201, reserved.body);

    const replay = await request(server()).post("/v1/reserve").auth(user, pass).send(paymentBody(requestId)).expect(409);
    expectDocumented("/v1/reserve", "post", 409, replay.body);

    const committed = await request(server()).post("/v1/commit").auth(user, pass).send({ requestId, responseBytes: 42 }).expect(201);
    expectDocumented("/v1/commit", "post", 201, committed.body);
  });

  it("POST /v1/reserve → rollback (201)", async () => {
    const { user, pass } = authed();
    const requestId = rid("ZE");
    await request(server()).post("/v1/reserve").auth(user, pass).send(paymentBody(requestId)).expect(201);
    const rolledBack = await request(server()).post("/v1/rollback").auth(user, pass).send({ requestId }).expect(201);
    expectDocumented("/v1/rollback", "post", 201, rolledBack.body);
  });

  it("GET /v1/identity/:id (200 and 404)", async () => {
    const { user, pass } = authed();
    const found = await request(server()).get("/v1/identity/fum@").auth(user, pass).expect(200);
    expectDocumented("/v1/identity/{id}", "get", 200, found.body);

    const missing = await request(server()).get("/v1/identity/nobody@").auth(user, pass).expect(404);
    expectDocumented("/v1/identity/{id}", "get", 404, missing.body);
  });

  it("401 uses the documented framework error shape", async () => {
    const res = await request(server()).post("/v1/verify").send(paymentBody(rid("ZF"))).expect(401);
    expectDocumented("/v1/verify", "post", 401, res.body);
  });

  it("admin endpoints: simulate-deposit, credit, reconcile", async () => {
    const simulated = await request(server())
      .post("/admin/simulate-deposit")
      .auth(ADMIN_TOKEN, { type: "bearer" })
      .send({ identity: PAYER, amount: "1" })
      .expect(201);
    expectDocumented("/admin/simulate-deposit", "post", 201, simulated.body);

    const credited = await request(server())
      .post("/admin/credit")
      .auth(ADMIN_TOKEN, { type: "bearer" })
      .send({ identity: PAYER, amount: "0.5", note: "openapi-test" })
      .expect(201);
    expectDocumented("/admin/credit", "post", 201, credited.body);

    const reconciled = await request(server()).post("/admin/reconcile").auth(ADMIN_TOKEN, { type: "bearer" }).expect(201);
    expectDocumented("/admin/reconcile", "post", 201, reconciled.body);
  });

  it("GET /metrics serves the Prometheus text format", async () => {
    const res = await request(server()).get("/metrics").expect(200);
    expect(res.headers["content-type"]).toContain("text/plain");
    expect(res.text).toContain("v402_requests_total");
  });

  it("every documented JSON success response was exercised above", () => {
    // completeness backstop: if a new path/operation lands in the OpenAPI
    // document, this list must grow — forgetting the e2e coverage fails here.
    const paths = openapi["paths"] as Record<string, Record<string, unknown>>;
    const documented = Object.entries(paths).flatMap(([p, ops]) => Object.keys(ops).map((m) => `${m.toUpperCase()} ${p}`));
    expect(documented.sort()).toEqual(
      [
        "POST /v1/verify",
        "POST /v1/reserve",
        "POST /v1/commit",
        "POST /v1/rollback",
        "GET /v1/identity/{id}",
        "GET /.well-known/v402",
        "GET /v1/topup-instructions",
        "GET /v1/balance",
        "GET /v1/health",
        "GET /metrics",
        "POST /admin/simulate-deposit",
        "POST /admin/credit",
        "POST /admin/reconcile",
      ].sort(),
    );
  });
});
