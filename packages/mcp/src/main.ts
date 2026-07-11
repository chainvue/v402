#!/usr/bin/env node
/**
 * v402 MCP server over stdio — the transport MCP hosts (Claude Desktop,
 * Claude Code, …) spawn. Configuration via env only:
 *
 *   required: V402_MCP_FACILITATOR, V402_MCP_IDENTITY, VERUS_SIGNING_KEY
 *   identity-mode signing (required on real chains):
 *             V402_MCP_IDENTITY_ADDRESS + V402_MCP_SYSTEM_ID
 *   guards:   V402_MCP_MAX_PER_REQUEST, V402_MCP_MAX_TOTAL,
 *             V402_MCP_ALLOWED_HOSTS (comma list)
 *
 * stdout belongs to the MCP protocol — diagnostics go to stderr.
 */
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { buildMcpConfig } from "./config.js";
import { buildMcpServer } from "./server.js";

async function main(): Promise<void> {
  const config = buildMcpConfig(process.env);
  const server = buildMcpServer(config);
  await server.connect(new StdioServerTransport());
  process.stderr.write(
    `v402-mcp ready: paying as ${config.identity} via ${config.facilitator}` +
      `${config.maxPerRequestSats !== undefined || config.maxTotalSats !== undefined ? " (spending caps active)" : ""}\n`,
  );
}

main().catch((err: unknown) => {
  process.stderr.write(`v402-mcp failed to start: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
