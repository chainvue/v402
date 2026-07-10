import type { V402ModuleOptions } from "@chainvue/v402-nestjs";

/**
 * Env-driven adapter options. Setting FACILITATOR_URL switches the demo to
 * http mode (docker-compose: the facilitator container owns the SQLite and
 * the Verus RPC); without it the demo runs the full stack in-process.
 */
export function demoOptionsFromEnv(env: NodeJS.ProcessEnv): V402ModuleOptions {
  const advertisement = {
    canonicalDomain: env["V402_CANONICAL_DOMAIN"] ?? "localhost:3001",
    network: env["V402_CHAIN"] ?? "vrsctest",
    asset: env["V402_ASSET"] ?? "VRSCTEST",
    payTo: env["V402_PAY_TO"] ?? "explorerAPI@",
    // what clients are told (public URL) — may differ from the internal URL the middleware calls
    facilitatorUrl: env["FACILITATOR_PUBLIC_URL"] ?? env["FACILITATOR_URL"] ?? "http://localhost:3000",
  };
  if (env["FACILITATOR_URL"] !== undefined) {
    return {
      mode: "http",
      ...advertisement,
      facilitatorAuthToken: env["FACILITATOR_AUTH_TOKEN"] ?? "",
      middlewareId: "demo-server",
    };
  }
  return {
    ...advertisement,
    db: { path: env["DB_PATH"] ?? "./data/demo-v402.sqlite" },
    verus: {
      rpcUrl: env["VERUS_RPC_URL"] ?? "http://127.0.0.1:18843",
      rpcUser: env["VERUS_RPC_USER"] ?? "",
      rpcPass: env["VERUS_RPC_PASS"] ?? "",
    },
  };
}

export function demoPort(env: NodeJS.ProcessEnv): number {
  return Number(env["PORT"] ?? 3001);
}
