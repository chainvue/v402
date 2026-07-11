#!/usr/bin/env node
/**
 * v402-proxy entrypoint: config from env + rules file, then serve until
 * SIGTERM/SIGINT (compose-friendly graceful shutdown).
 *
 * Required env: V402_PROXY_UPSTREAM, V402_PROXY_RULES_PATH,
 * FACILITATOR_URL (+ FACILITATOR_PUBLIC_URL when the advertised URL
 * differs), FACILITATOR_AUTH_TOKEN, V402_CANONICAL_DOMAIN, V402_NETWORK,
 * V402_ASSET, V402_PAY_TO. Optional: V402_PROXY_HOST/PORT (0.0.0.0:8402),
 * V402_PROXY_MIDDLEWARE_ID, V402_PROXY_MAX_BODY_BYTES.
 */
import { buildProxyConfig } from "./config.js";
import { createProxyServer } from "./server.js";

const out = (line: Record<string, unknown>): void => {
  process.stdout.write(JSON.stringify({ time: Date.now(), ...line }) + "\n");
};

try {
  const config = buildProxyConfig(process.env);
  const server = createProxyServer(config);
  server.listen(config.listen.port, config.listen.host, () => {
    out({
      level: "info",
      msg: "v402-proxy listening",
      host: config.listen.host,
      port: config.listen.port,
      upstream: config.upstreamOrigin,
      rules: config.rules.length,
    });
  });
  const shutdown = (signal: string): void => {
    out({ level: "info", msg: `${signal} — shutting down` });
    server.close(() => process.exit(0));
    // in-flight requests get a grace period, then hard exit
    setTimeout(() => process.exit(0), 10_000).unref();
  };
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
} catch (err) {
  process.stderr.write(`v402-proxy failed to start: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
}
