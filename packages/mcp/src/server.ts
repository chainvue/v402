import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
  humanToSats,
  payment402ResponseSchema,
  satsToHuman,
  SCHEME_VERUS_PREPAID_SIG,
} from "@chainvue/v402-protocol";
import { LocalKeySigner } from "@chainvue/v402-signer-verus";
import { V402Client, facilitatorHeightProvider } from "@chainvue/v402-client-fetch";
import type { McpConfig } from "./config.js";

export interface McpDeps {
  fetchImpl?: typeof fetch;
}

/** Body text returned to the model is capped — models don't need megabytes. */
const BODY_CAP = 50_000;

interface ToolText {
  [key: string]: unknown;
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
}

const ok = (value: unknown): ToolText => ({
  content: [{ type: "text", text: typeof value === "string" ? value : JSON.stringify(value, null, 2) }],
});
const refuse = (text: string): ToolText => ({ content: [{ type: "text", text }], isError: true });

/**
 * The v402 MCP server: lets an MCP host (Claude Desktop/Code, …) pay for
 * APIs mid-conversation from a prepaid VerusID balance. Spending protection
 * lives HERE, on the agent boundary: an optional per-request cap, a
 * cumulative per-process cap, and a host allowlist — the model can never
 * spend more than the operator configured, no matter what it is asked.
 */
export function buildMcpServer(config: McpConfig, deps: McpDeps = {}): McpServer {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const signer = new LocalKeySigner(config.signingKey, {
    ...(config.identityAddress !== undefined && config.systemId !== undefined
      ? {
          identity: { identityAddress: config.identityAddress, systemId: config.systemId },
          heightProvider: facilitatorHeightProvider(config.facilitator, fetchImpl),
        }
      : {}),
  });
  const client = new V402Client({
    identity: config.identity,
    signer,
    facilitator: config.facilitator,
    fetchImpl,
  });

  let spentSats = 0n;

  const server = new McpServer({ name: "v402", version: "0.1.0" });

  server.registerTool(
    "v402_paid_fetch",
    {
      title: "Fetch a v402-priced URL, paying automatically",
      description:
        "Fetch a URL that may require v402 payment. Free URLs pass through; priced URLs are paid " +
        "from the configured VerusID balance — within the operator's spending caps. Returns the " +
        "HTTP status, the price paid (if any) and the response body (truncated).",
      inputSchema: {
        url: z.string().url().describe("Absolute http(s) URL to fetch"),
        method: z.enum(["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD"]).default("GET"),
        body: z.string().optional().describe("Request body (string; sent as-is)"),
        contentType: z.string().optional().describe("Content-Type for the body"),
      },
    },
    async ({ url, method, body, contentType }) => {
      const target = new URL(url);
      if (config.allowedHosts !== undefined && !config.allowedHosts.includes(target.host)) {
        return refuse(`host ${target.host} is not in the operator's allowlist (${config.allowedHosts.join(", ")})`);
      }
      const init: RequestInit = {
        method,
        ...(body !== undefined ? { body } : {}),
        ...(contentType !== undefined ? { headers: { "content-type": contentType } } : {}),
      };

      // probe first: learn the price BEFORE committing to pay (spending caps)
      const probe = await fetchImpl(url, init);
      if (probe.status !== 402) {
        const text = await probe.text();
        return ok({ status: probe.status, paid: null, body: clip(text) });
      }
      const challenge = payment402ResponseSchema.safeParse(await probe.json());
      const entry = challenge.success
        ? challenge.data.accepts.find((a) => a.scheme === SCHEME_VERUS_PREPAID_SIG)
        : undefined;
      if (entry === undefined) return refuse("endpoint answered 402 but offered no scheme this agent supports");
      const price = humanToSats(entry.amount as string);

      if (config.maxPerRequestSats !== undefined && price > config.maxPerRequestSats) {
        return refuse(
          `refusing to pay ${entry.amount as string} ${entry.asset as string}: above the per-request cap of ${satsToHuman(config.maxPerRequestSats)}`,
        );
      }
      if (config.maxTotalSats !== undefined && spentSats + price > config.maxTotalSats) {
        return refuse(
          `refusing to pay ${entry.amount as string} ${entry.asset as string}: session spend ${satsToHuman(spentSats)} would exceed the total cap of ${satsToHuman(config.maxTotalSats)}`,
        );
      }

      const response = await client.fetch(url, init);
      const text = await response.text();
      if (response.status !== 402) spentSats += price; // definitive answer = charged (2xx/4xx)
      return ok({
        status: response.status,
        paid: response.status === 402 ? null : { amount: entry.amount, asset: entry.asset },
        requestId: response.headers.get("x-v402-request-id"),
        sessionSpent: satsToHuman(spentSats),
        body: clip(text),
      });
    },
  );

  server.registerTool(
    "v402_balance",
    {
      title: "Check the agent's prepaid v402 balance",
      description: "Signature-authenticated balance query against the facilitator: balance, reserved, available.",
      inputSchema: {},
    },
    async () => ok(await client.getBalance()),
  );

  server.registerTool(
    "v402_topup_instructions",
    {
      title: "Get deposit instructions to top up the balance",
      description: "How to fund the agent's identity: transfer text, payment URI and QR code from the facilitator.",
      inputSchema: {
        amount: z.string().regex(/^[0-9]+(\.[0-9]+)?$/).optional().describe("Optional human amount to embed"),
      },
    },
    async ({ amount }) => ok(await client.getTopupInstructions(amount !== undefined ? { amount } : {})),
  );

  server.registerTool(
    "v402_discover",
    {
      title: "Discover a v402 service",
      description:
        "Fetch a service's /.well-known/v402: schemes, payTo, topup pointers and — for guarded APIs — the endpoint rate card. Without a URL, describes the configured facilitator.",
      inputSchema: {
        baseUrl: z.string().url().optional().describe("Service base URL; defaults to the facilitator"),
      },
    },
    async ({ baseUrl }) => ok(await client.discover(baseUrl)),
  );

  return server;
}

function clip(text: string): string {
  return text.length > BODY_CAP ? `${text.slice(0, BODY_CAP)}… [truncated, ${text.length} chars total]` : text;
}
