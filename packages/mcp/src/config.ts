import { humanToSats } from "@chainvue/v402-protocol";
import { z } from "zod";

const configSchema = z.object({
  /** Facilitator base URL (balance/topup/discovery + chain-height source). */
  facilitator: z.string().url(),
  /** VerusID the agent pays as (X-V402-Payer). */
  identity: z.string().min(2).endsWith("@"),
  /** WIF private key — a primary key of `identity`. */
  signingKey: z.string().min(1),
  /**
   * Identity-mode signing (REQUIRED against a real chain): the identity's
   * i-address and the chain's i-address. Without them the signer falls back
   * to plain address signatures, which real daemons reject for `…@` payers.
   */
  identityAddress: z.string().min(1).optional(),
  systemId: z.string().min(1).optional(),
  /** Refuse to pay more than this per request (human amount, e.g. "0.01"). */
  maxPerRequest: z.string().regex(/^[0-9]+(\.[0-9]+)?$/).optional(),
  /** Refuse once cumulative spend of this server process exceeds this. */
  maxTotal: z.string().regex(/^[0-9]+(\.[0-9]+)?$/).optional(),
  /** Comma list of hosts the agent may call (e.g. "api.example.com:443,demo.local:8080"). Unset = any. */
  allowedHosts: z.array(z.string().min(1)).optional(),
});

export type McpConfig = z.infer<typeof configSchema> & {
  maxPerRequestSats?: bigint;
  maxTotalSats?: bigint;
};

/** Env → validated config; fails fast with a readable message. */
export function buildMcpConfig(env: Record<string, string | undefined>): McpConfig {
  const parsed = configSchema.parse({
    facilitator: env["V402_MCP_FACILITATOR"],
    identity: env["V402_MCP_IDENTITY"],
    signingKey: env["VERUS_SIGNING_KEY"],
    ...(env["V402_MCP_IDENTITY_ADDRESS"] !== undefined ? { identityAddress: env["V402_MCP_IDENTITY_ADDRESS"] } : {}),
    ...(env["V402_MCP_SYSTEM_ID"] !== undefined ? { systemId: env["V402_MCP_SYSTEM_ID"] } : {}),
    ...(env["V402_MCP_MAX_PER_REQUEST"] !== undefined ? { maxPerRequest: env["V402_MCP_MAX_PER_REQUEST"] } : {}),
    ...(env["V402_MCP_MAX_TOTAL"] !== undefined ? { maxTotal: env["V402_MCP_MAX_TOTAL"] } : {}),
    ...(env["V402_MCP_ALLOWED_HOSTS"] !== undefined
      ? { allowedHosts: env["V402_MCP_ALLOWED_HOSTS"].split(",").map((h) => h.trim()).filter((h) => h !== "") }
      : {}),
  });
  if ((parsed.identityAddress === undefined) !== (parsed.systemId === undefined)) {
    throw new Error("v402-mcp: V402_MCP_IDENTITY_ADDRESS and V402_MCP_SYSTEM_ID must be set together");
  }
  return {
    ...parsed,
    ...(parsed.maxPerRequest !== undefined ? { maxPerRequestSats: humanToSats(parsed.maxPerRequest) } : {}),
    ...(parsed.maxTotal !== undefined ? { maxTotalSats: humanToSats(parsed.maxTotal) } : {}),
  };
}
