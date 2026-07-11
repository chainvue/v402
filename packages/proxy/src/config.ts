import { readFileSync } from "node:fs";
import { z } from "zod";

/**
 * One routing rule. First match wins — order free-hole rules (e.g. a free
 * /api/health inside a priced /api/*) BEFORE the broader priced prefix.
 */
const ruleSchema = z
  .object({
    /** Exact pathname ("/api/report") or prefix pattern ("/api/*"). Matched against the pathname only (query excluded). */
    match: z.string().regex(/^\//, "match must start with /"),
    /** HTTP method(s); omitted = every method. */
    method: z.union([z.string(), z.array(z.string()).min(1)]).optional(),
    /** Explicit free hole inside a broader priced pattern. */
    free: z.literal(true).optional(),
    /** Price as the exact decimal string advertised in the 402 (byte-verbatim, M6). */
    price: z.string().regex(/^[0-9]+(\.[0-9]+)?$/).optional(),
    /**
     * Body binding. Default "ignored" — the proxy STREAMS request bodies;
     * "required"/"optional" buffer the body (up to maxBodyBytes) to hash it.
     */
    bodyHash: z.enum(["required", "optional", "ignored"]).default("ignored"),
  })
  .strict()
  .superRefine((rule, ctx) => {
    if (rule.free === true && rule.price !== undefined) {
      ctx.addIssue({ code: "custom", message: "a rule is either free or priced, not both" });
    }
    if (rule.free !== true && rule.price === undefined) {
      ctx.addIssue({ code: "custom", message: "a non-free rule needs a price" });
    }
  });

const rulesFileSchema = z
  .object({
    version: z.literal(1).default(1),
    rules: z.array(ruleSchema),
  })
  .strict();

export type ProxyRule = z.infer<typeof ruleSchema>;

const configSchema = z.object({
  listen: z.object({
    host: z.string().default("0.0.0.0"),
    port: z.coerce.number().int().min(1).max(65535).default(8402),
  }),
  /** Origin the proxy forwards to, e.g. http://origin:8080 — path/query pass through verbatim. */
  upstreamOrigin: z.string().url(),
  facilitator: z.object({
    /** Base URL advertised to CLIENTS (discovery/topup/balance). */
    url: z.string().url(),
    /** URL the proxy itself calls (in-cluster address). Defaults to `url`. */
    internalUrl: z.string().url().optional(),
    authToken: z.string().min(1),
    middlewareId: z.string().default("v402-proxy"),
  }),
  advertisement: z.object({
    canonicalDomain: z.string().min(1),
    network: z.string().min(1),
    asset: z.string().min(1),
    payTo: z.string().min(1),
  }),
  /** Buffering cap for bodyHash-policy routes; streamed routes are unlimited. */
  maxBodyBytes: z.coerce.number().int().positive().default(1_048_576),
  rules: z.array(ruleSchema),
});

export type ProxyConfig = z.infer<typeof configSchema>;

/**
 * Build the proxy config from environment variables + the mounted rules
 * file (V402_PROXY_RULES_PATH). Fails fast with a readable zod error.
 */
export function buildProxyConfig(env: Record<string, string | undefined>, overrides: Record<string, unknown> = {}): ProxyConfig {
  const rulesPath = env["V402_PROXY_RULES_PATH"];
  let rules: unknown;
  if (rulesPath !== undefined) {
    let raw: string;
    try {
      raw = readFileSync(rulesPath, "utf8");
    } catch (err) {
      throw new Error(`v402-proxy: cannot read rules file ${rulesPath}: ${err instanceof Error ? err.message : String(err)}`, { cause: err });
    }
    try {
      rules = rulesFileSchema.parse(JSON.parse(raw)).rules;
    } catch (err) {
      throw new Error(`v402-proxy: invalid rules file ${rulesPath}: ${err instanceof Error ? err.message : String(err)}`, { cause: err });
    }
  }

  const candidate = {
    listen: {
      ...(env["V402_PROXY_HOST"] !== undefined ? { host: env["V402_PROXY_HOST"] } : {}),
      ...(env["V402_PROXY_PORT"] !== undefined ? { port: env["V402_PROXY_PORT"] } : {}),
    },
    upstreamOrigin: env["V402_PROXY_UPSTREAM"],
    facilitator: {
      url: env["FACILITATOR_PUBLIC_URL"] ?? env["FACILITATOR_URL"],
      ...(env["FACILITATOR_URL"] !== undefined && env["FACILITATOR_PUBLIC_URL"] !== undefined
        ? { internalUrl: env["FACILITATOR_URL"] }
        : {}),
      authToken: env["FACILITATOR_AUTH_TOKEN"],
      ...(env["V402_PROXY_MIDDLEWARE_ID"] !== undefined ? { middlewareId: env["V402_PROXY_MIDDLEWARE_ID"] } : {}),
    },
    advertisement: {
      canonicalDomain: env["V402_CANONICAL_DOMAIN"],
      network: env["V402_NETWORK"],
      asset: env["V402_ASSET"],
      payTo: env["V402_PAY_TO"],
    },
    ...(env["V402_PROXY_MAX_BODY_BYTES"] !== undefined ? { maxBodyBytes: env["V402_PROXY_MAX_BODY_BYTES"] } : {}),
    ...(rules !== undefined ? { rules } : {}),
    ...overrides,
  };
  return configSchema.parse(candidate);
}

/** First matching rule wins; undefined = free pass-through. */
export function matchRule(rules: ProxyRule[], method: string, pathname: string): ProxyRule | undefined {
  const upper = method.toUpperCase();
  for (const rule of rules) {
    if (rule.method !== undefined) {
      const methods = (Array.isArray(rule.method) ? rule.method : [rule.method]).map((m) => m.toUpperCase());
      if (!methods.includes(upper)) continue;
    }
    if (rule.match.endsWith("*")) {
      if (pathname.startsWith(rule.match.slice(0, -1))) return rule;
    } else if (pathname === rule.match) {
      return rule;
    }
  }
  return undefined;
}
