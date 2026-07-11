import { describe, expect, it } from "vitest";
import { buildConfig } from "../src/config/schema.js";

describe("buildConfig", () => {
  it("produces the documented defaults from an empty env", () => {
    const config = buildConfig({});
    expect(config.server).toEqual({ port: 3000, host: "127.0.0.1" });
    expect(config.verus.rpcUrl).toBe("http://127.0.0.1:18843");
    expect(config.verus.circuit).toEqual({ timeoutMs: 500, failuresBeforeOpen: 5, recoveryMs: 30_000 });
    expect(config.defaultScheme).toBe("verus-prepaid-sig");
    expect(config.schemes[0]?.config.payToIdentity).toBe("explorerAPI@");
    expect(config.payment).toMatchObject({
      canonicalDomain: "localhost:3000",
      timestampToleranceSec: 300,
      reserveTtlSec: 300,
      supportedVersions: ["v402/0.1"],
      supportedExtensions: ["scheme.bodyHash"],
      maxExtensionsBytes: 4096,
      bodyHashDefaultPolicy: "optional",
    });
    expect(config.watcher).toEqual({ mode: "real", intervalMs: 15_000, minConfirmations: 10, reorgLookbackBlocks: 20 });
    expect(config.cors.allowedOrigins).toEqual([]); // default-deny
    expect(config.throttle).toEqual({ unauthPerMinute: 100, skipAuthenticated: true });
    expect(config.reconciliation).toEqual({ enabled: true, cron: "0 3 * * *" });
  });

  it("applies documented env overrides", () => {
    const config = buildConfig({
      PORT: "3005",
      DB_PATH: "/data/x.sqlite",
      VERUS_RPC_URL: "http://node:18843",
      VERUS_RPC_USER: "u",
      VERUS_RPC_PASS: "p",
      V402_PAY_TO: "myAPI@",
      V402_CANONICAL_DOMAIN: "api.example.com",
      V402_WATCHER_MODE: "simulated",
      V402_VERIFIER_MODE: "offline",
      V402_IDENTITY_CACHE_TTL_SEC: "120",
      V402_ADMIN_TOKEN: "t0ken",
      LOG_LEVEL: "debug",
      NODE_ENV: "test",
    });
    expect(config.server.port).toBe(3005);
    expect(config.db.path).toBe("/data/x.sqlite");
    expect(config.verus).toMatchObject({ rpcUrl: "http://node:18843", rpcUser: "u", rpcPass: "p" });
    expect(config.schemes[0]?.config.payToIdentity).toBe("myAPI@");
    expect(config.payment.canonicalDomain).toBe("api.example.com");
    expect(config.watcher.mode).toBe("simulated");
    expect(config.verifier).toMatchObject({ mode: "offline", identityCacheTtlSec: 120 });
    expect(config.ops.adminToken).toBe("t0ken");
    expect(config.logging.level).toBe("debug");
  });

  it("supports programmatic overrides for tests", () => {
    const config = buildConfig({}, { db: { path: ":memory:" }, logging: { level: "silent" } });
    expect(config.db.path).toBe(":memory:");
    expect(config.logging.level).toBe("silent");
    expect(config.server.port).toBe(3000); // untouched sections keep defaults
  });

  it.each([
    ["invalid port", { PORT: "0" }],
    ["invalid watcher mode", { V402_WATCHER_MODE: "fake" }],
    ["invalid verifier mode", { V402_VERIFIER_MODE: "cloud" }],
    ["invalid identity cache ttl", { V402_IDENTITY_CACHE_TTL_SEC: "-1" }],
    ["invalid log level", { LOG_LEVEL: "verbose" }],
  ])("fails boot on %s", (_name, env) => {
    expect(() => buildConfig(env as NodeJS.ProcessEnv)).toThrow();
  });

  it("fails boot when defaultScheme is not among enabled schemes", () => {
    expect(() => buildConfig({}, { defaultScheme: "evm-eip3009" })).toThrow(/defaultScheme/);
  });

  it("fails boot when facilitator.mode=http without httpUrl", () => {
    expect(() => buildConfig({}, { facilitator: { mode: "http" } })).toThrow(/httpUrl/);
  });

  it("fails boot on simulated watcher in production without the explicit override", () => {
    const env = { NODE_ENV: "production", V402_WATCHER_MODE: "simulated" };
    expect(() => buildConfig(env)).toThrow(/V402_ALLOW_SIMULATED_IN_PROD/);
    expect(buildConfig({ ...env, V402_ALLOW_SIMULATED_IN_PROD: "true" }).watcher.mode).toBe("simulated");
  });
});
