import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildProxyConfig, matchRule, type ProxyRule } from "../src/index.js";

const ENV = {
  V402_PROXY_UPSTREAM: "http://origin:8080",
  FACILITATOR_URL: "http://facilitator:3000",
  FACILITATOR_AUTH_TOKEN: "token",
  V402_CANONICAL_DOMAIN: "api.example.com",
  V402_NETWORK: "vrsctest",
  V402_ASSET: "VRSCTEST",
  V402_PAY_TO: "myAPI@",
};

describe("matchRule", () => {
  const rules: ProxyRule[] = [
    { match: "/api/health", free: true, bodyHash: "ignored" },
    { match: "/api/upload", method: "POST", price: "0.002", bodyHash: "required" },
    { match: "/api/*", price: "0.001", bodyHash: "ignored" },
  ];

  it("first match wins — free holes before broad prefixes", () => {
    expect(matchRule(rules, "GET", "/api/health")?.free).toBe(true);
    expect(matchRule(rules, "GET", "/api/anything")?.price).toBe("0.001");
  });

  it("filters by method, falling through to later rules", () => {
    expect(matchRule(rules, "POST", "/api/upload")?.price).toBe("0.002");
    // GET /api/upload skips the POST rule and lands on the prefix
    expect(matchRule(rules, "GET", "/api/upload")?.price).toBe("0.001");
  });

  it("prefix patterns need the trailing *; exact matches are exact", () => {
    expect(matchRule(rules, "GET", "/api")).toBeUndefined();
    expect(matchRule(rules, "GET", "/other")).toBeUndefined();
  });
});

describe("buildProxyConfig", () => {
  it("builds from env + overrides and applies defaults", () => {
    const config = buildProxyConfig(ENV, { rules: [{ match: "/x", price: "1" }] });
    expect(config.listen).toEqual({ host: "0.0.0.0", port: 8402 });
    expect(config.facilitator.middlewareId).toBe("v402-proxy");
    expect(config.maxBodyBytes).toBe(1_048_576);
    expect(config.rules[0]).toMatchObject({ match: "/x", price: "1", bodyHash: "ignored" });
  });

  it("separates advertised and internal facilitator URLs", () => {
    const config = buildProxyConfig(
      { ...ENV, FACILITATOR_PUBLIC_URL: "https://pay.example.com", FACILITATOR_URL: "http://facilitator:3000" },
      { rules: [] },
    );
    expect(config.facilitator.url).toBe("https://pay.example.com");
    expect(config.facilitator.internalUrl).toBe("http://facilitator:3000");
  });

  it("fails fast on missing required env", () => {
    expect(() => buildProxyConfig({ ...ENV, FACILITATOR_AUTH_TOKEN: undefined }, { rules: [] })).toThrow();
    expect(() => buildProxyConfig({ ...ENV, V402_PROXY_UPSTREAM: "not a url" }, { rules: [] })).toThrow();
  });

  it("loads and validates the rules file, rejecting free+price conflicts", () => {
    const dir = mkdtempSync(join(tmpdir(), "v402-proxy-rules-"));
    const good = join(dir, "rules.json");
    writeFileSync(good, JSON.stringify({ rules: [{ match: "/api/*", price: "0.001" }] }));
    expect(buildProxyConfig({ ...ENV, V402_PROXY_RULES_PATH: good }).rules).toHaveLength(1);

    const conflicted = join(dir, "bad.json");
    writeFileSync(conflicted, JSON.stringify({ rules: [{ match: "/a", free: true, price: "1" }] }));
    expect(() => buildProxyConfig({ ...ENV, V402_PROXY_RULES_PATH: conflicted })).toThrow(/free or priced/);

    const unpriced = join(dir, "unpriced.json");
    writeFileSync(unpriced, JSON.stringify({ rules: [{ match: "/a" }] }));
    expect(() => buildProxyConfig({ ...ENV, V402_PROXY_RULES_PATH: unpriced })).toThrow(/needs a price/);

    expect(() => buildProxyConfig({ ...ENV, V402_PROXY_RULES_PATH: join(dir, "missing.json") })).toThrow(/cannot read/);
  });
});
