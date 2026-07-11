import { z } from "zod";
import { PROTOCOL_VERSION, SCHEME_VERUS_PREPAID_SIG } from "@chainvue/v402-protocol";

/**
 * Facilitator configuration, Zod-validated at boot (env reference: docs/integration/facilitator-docker.md).
 * Defaults live here; environment variables override the deployment-specific
 * values (see buildConfig). Secrets only ever arrive via env.
 */
export const facilitatorConfigSchema = z
  .object({
    server: z.object({
      port: z.number().int().min(1).max(65_535).default(3000),
      host: z.string().min(1).default("127.0.0.1"),
    }),
    facilitator: z.object({
      mode: z.enum(["in-process", "http"]).default("in-process"),
      httpUrl: z.string().default(""),
      authToken: z.string().default(""),
    }),
    db: z.object({
      path: z.string().min(1).default("./data/v402.sqlite"),
      walMode: z.boolean().default(true),
    }),
    verus: z.object({
      rpcUrl: z.string().min(1).default("http://127.0.0.1:18843"),
      rpcUser: z.string().default(""),
      rpcPass: z.string().default(""),
      chain: z.string().min(1).default("vrsctest"),
      circuit: z.object({
        timeoutMs: z.number().int().positive().default(500),
        failuresBeforeOpen: z.number().int().positive().default(5),
        recoveryMs: z.number().int().positive().default(30_000),
      }),
    }),
    verifier: z.object({
      mode: z.enum(["rpc", "offline"]).default("rpc"),
      identityCacheTtlSec: z.number().int().positive().default(60),
      identityCacheMaxSize: z.number().int().positive().default(10_000),
    }),
    schemes: z
      .array(
        z.object({
          name: z.string().min(1),
          enabled: z.boolean().default(true),
          config: z.object({
            asset: z.string().min(1).default("VRSCTEST"),
            payToIdentity: z.string().min(2).endsWith("@").default("explorerAPI@"),
          }),
        }),
      )
      .min(1),
    defaultScheme: z.string().min(1).default(SCHEME_VERUS_PREPAID_SIG),
    payment: z.object({
      specUrl: z.string().min(1).default("https://github.com/chainvue/v402/tree/main/spec"),
      canonicalDomain: z.string().min(1).default("localhost:3000"),
      timestampToleranceSec: z.number().int().positive().default(300),
      /** Reaper threshold (B3) — MUST exceed the slowest endpoint's runtime. */
      reserveTtlSec: z.number().int().positive().default(300),
      supportedVersions: z.array(z.string().min(1)).min(1).default([PROTOCOL_VERSION]),
      defaultVersion: z.string().min(1).default(PROTOCOL_VERSION),
      supportedExtensions: z.array(z.string().min(1)).default(["scheme.bodyHash"]),
      maxExtensionsBytes: z.number().int().positive().default(4096),
      bodyHashDefaultPolicy: z.enum(["required", "optional", "ignored"]).default("optional"),
    }),
    watcher: z.object({
      mode: z.enum(["real", "simulated"]).default("real"),
      intervalMs: z.number().int().min(100).default(15_000),
      minConfirmations: z.number().int().min(1).default(10),
      reorgLookbackBlocks: z.number().int().min(1).default(20),
    }),
    cors: z.object({
      /** Empty = deny all cross-origin requests (default-deny, opt-in). */
      allowedOrigins: z.array(z.string().min(1)).default([]),
    }),
    throttle: z.object({
      unauthPerMinute: z.number().int().positive().default(100),
      skipAuthenticated: z.boolean().default(true),
    }),
    logging: z.object({
      level: z.enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"]).default("info"),
      prettyPrint: z.boolean().default(false),
      identityHashLength: z.number().int().min(4).max(64).default(12),
    }),
    metrics: z.object({
      enabled: z.boolean().default(true),
      path: z.string().startsWith("/").default("/metrics"),
    }),
    reconciliation: z.object({
      enabled: z.boolean().default(true),
      cron: z.string().min(1).default("0 3 * * *"),
    }),
    ops: z.object({
      adminToken: z.string().default(""),
      allowSimulatedInProd: z.boolean().default(false),
    }),
    nodeEnv: z.string().default("development"),
  })
  .superRefine((config, ctx) => {
    if (!config.schemes.some((s) => s.enabled && s.name === config.defaultScheme)) {
      ctx.addIssue({
        code: "custom",
        path: ["defaultScheme"],
        message: `defaultScheme "${config.defaultScheme}" is not among the enabled schemes`,
      });
    }
    if (config.facilitator.mode === "http" && config.facilitator.httpUrl === "") {
      ctx.addIssue({
        code: "custom",
        path: ["facilitator", "httpUrl"],
        message: "facilitator.httpUrl is required when facilitator.mode is 'http'",
      });
    }
    if (config.watcher.mode === "simulated" && config.nodeEnv === "production" && !config.ops.allowSimulatedInProd) {
      ctx.addIssue({
        code: "custom",
        path: ["watcher", "mode"],
        message:
          "simulated watcher refused with NODE_ENV=production — set V402_ALLOW_SIMULATED_IN_PROD=true only if you really mean it",
      });
    }
  });

export type FacilitatorConfig = z.infer<typeof facilitatorConfigSchema>;

/** Two-level merge: sections are flat objects, overrides win per key. */
function mergeSections(base: Record<string, unknown>, overrides: Record<string, unknown>): Record<string, unknown> {
  const merged: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(overrides)) {
    const current = merged[key];
    merged[key] =
      value !== null && typeof value === "object" && !Array.isArray(value) && typeof current === "object" && current !== null
        ? { ...current, ...value }
        : value;
  }
  return merged;
}

/**
 * Assemble the config from defaults + documented env vars (+ optional
 * programmatic overrides for tests). Throws ZodError at boot on anything
 * invalid — the facilitator never starts on a bad config.
 */
export function buildConfig(env: NodeJS.ProcessEnv, overrides: Record<string, unknown> = {}): FacilitatorConfig {
  const fromEnv: Record<string, unknown> = {
    server: {
      ...(env["PORT"] !== undefined ? { port: Number(env["PORT"]) } : {}),
      ...(env["HOST"] !== undefined ? { host: env["HOST"] } : {}),
    },
    facilitator: {
      ...(env["FACILITATOR_AUTH_TOKEN"] !== undefined ? { authToken: env["FACILITATOR_AUTH_TOKEN"] } : {}),
    },
    db: { ...(env["DB_PATH"] !== undefined ? { path: env["DB_PATH"] } : {}) },
    verus: {
      ...(env["VERUS_RPC_URL"] !== undefined ? { rpcUrl: env["VERUS_RPC_URL"] } : {}),
      ...(env["VERUS_RPC_USER"] !== undefined ? { rpcUser: env["VERUS_RPC_USER"] } : {}),
      ...(env["VERUS_RPC_PASS"] !== undefined ? { rpcPass: env["VERUS_RPC_PASS"] } : {}),
      ...(env["V402_CHAIN"] !== undefined ? { chain: env["V402_CHAIN"] } : {}),
      circuit: {},
    },
    verifier: {
      ...(env["V402_VERIFIER_MODE"] !== undefined ? { mode: env["V402_VERIFIER_MODE"] } : {}),
      ...(env["V402_IDENTITY_CACHE_TTL_SEC"] !== undefined
        ? { identityCacheTtlSec: Number(env["V402_IDENTITY_CACHE_TTL_SEC"]) }
        : {}),
    },
    schemes: [
      {
        name: SCHEME_VERUS_PREPAID_SIG,
        enabled: true,
        config: {
          asset: env["V402_ASSET"] ?? "VRSCTEST",
          payToIdentity: env["V402_PAY_TO"] ?? "explorerAPI@",
        },
      },
    ],
    payment: {
      ...(env["V402_CANONICAL_DOMAIN"] !== undefined ? { canonicalDomain: env["V402_CANONICAL_DOMAIN"] } : {}),
    },
    watcher: {
      ...(env["V402_WATCHER_MODE"] !== undefined ? { mode: env["V402_WATCHER_MODE"] } : {}),
    },
    cors: {},
    throttle: {},
    logging: {
      ...(env["LOG_LEVEL"] !== undefined ? { level: env["LOG_LEVEL"] } : {}),
      ...(env["NODE_ENV"] !== "production" ? { prettyPrint: env["V402_LOG_PRETTY"] === "true" } : {}),
    },
    metrics: {},
    reconciliation: {},
    ops: {
      ...(env["V402_ADMIN_TOKEN"] !== undefined ? { adminToken: env["V402_ADMIN_TOKEN"] } : {}),
      allowSimulatedInProd: env["V402_ALLOW_SIMULATED_IN_PROD"] === "true",
    },
    ...(env["NODE_ENV"] !== undefined ? { nodeEnv: env["NODE_ENV"] } : {}),
  };
  return facilitatorConfigSchema.parse(mergeSections(fromEnv, overrides));
}
