import http, { type IncomingMessage, type ServerResponse } from "node:http";
import https from "node:https";
import { PROTOCOL_VERSION, SCHEME_VERUS_PREPAID_SIG } from "@chainvue/v402-protocol";
import {
  HttpFacilitatorVerifier,
  VerifierRegistry,
  build402Body,
  type PaymentAdvertisement,
  type RoutePolicy,
  type SchemeVerifier,
  type VerifyError,
} from "@chainvue/v402-verifier";
import { matchRule, type ProxyConfig, type ProxyRule } from "./config.js";

/** Hop-by-hop headers never forwarded in either direction (RFC 9110 §7.6.1). */
const HOP_BY_HOP = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);

export interface ProxyDeps {
  /** Test seam — replaces the HttpFacilitatorVerifier. */
  verifier?: SchemeVerifier;
  log?: (line: Record<string, unknown>) => void;
}

const defaultLog = (line: Record<string, unknown>): void => {
  process.stdout.write(JSON.stringify({ time: Date.now(), ...line }) + "\n");
};

/**
 * The v402 reverse proxy: a payment guard in front of ANY origin. Free (or
 * unmatched) routes stream through untouched; priced routes run the same
 * two-phase flow as the NestJS adapter — 402 challenge, verify+reserve via
 * the facilitator, forward upstream, commit on a definitive answer (2xx AND
 * 4xx — a rendered service), rollback on upstream failure (≥500 / network).
 */
export function createProxyServer(config: ProxyConfig, deps: ProxyDeps = {}): http.Server {
  const log = deps.log ?? defaultLog;
  const advertisement: PaymentAdvertisement = { ...config.advertisement, facilitatorUrl: config.facilitator.url };
  const registry = new VerifierRegistry();
  registry.register(
    deps.verifier ??
      new HttpFacilitatorVerifier({
        scheme: SCHEME_VERUS_PREPAID_SIG,
        baseUrl: config.facilitator.internalUrl ?? config.facilitator.url,
        authToken: config.facilitator.authToken,
        middlewareId: config.facilitator.middlewareId,
      }),
  );
  const upstream = new URL(config.upstreamOrigin);

  return http.createServer((req, res) => {
    handle(req, res).catch((err: unknown) => {
      log({ level: "error", msg: "unhandled proxy error", error: err instanceof Error ? err.message : String(err) });
      if (!res.headersSent) sendJson(res, 500, { ok: false, error: { code: "proxy-error", message: "internal proxy error" } });
      else res.destroy();
    });
  });

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const target = req.url ?? "/";
    const method = (req.method ?? "GET").toUpperCase();
    const pathname = new URL(target, "http://placeholder").pathname;

    if (pathname === "/.well-known/v402") {
      sendJson(res, 200, discoveryDocument());
      return;
    }
    if (pathname === "/.well-known/v402/health") {
      sendJson(res, 200, { status: "ok" });
      return;
    }

    const rule = matchRule(config.rules, method, pathname);
    if (rule === undefined || rule.free === true) {
      await forward(req, res, undefined, undefined);
      return;
    }

    const policy: RoutePolicy = { priceHuman: rule.price!, bodyHashPolicy: rule.bodyHash };
    const verifier = registry.get(SCHEME_VERUS_PREPAID_SIG)!;

    // no signature header → this is the challenge leg of the handshake
    if (req.headers["x-v402-signature"] === undefined) {
      drain(req);
      sendJson(res, 402, build402Body(advertisement, registry, policy));
      return;
    }

    // bodyHash policies need the raw bytes — buffer (bounded); everything
    // else streams through without touching the body
    let rawBody: Uint8Array | undefined;
    if (rule.bodyHash !== "ignored" && method !== "GET" && method !== "HEAD") {
      const buffered = await readBody(req, config.maxBodyBytes);
      if (buffered === undefined) {
        sendJson(res, 413, { ok: false, error: { code: "body-too-large", message: `bodyHash routes buffer at most ${config.maxBodyBytes} bytes` } });
        return;
      }
      rawBody = buffered;
    }

    const result = await verifier.verifyAndReserve(
      { method, path: target, headers: req.headers, ...(rawBody !== undefined ? { rawBody } : {}) },
      policy,
    );
    if (!result.ok) {
      drain(req);
      sendVerifyError(res, registry, advertisement, policy, result.error);
      return;
    }

    res.setHeader("x-v402-request-id", result.requestId);
    const outcome = await forward(req, res, rawBody, result.requestId);

    // phase 2 — Stripe semantics: definitive answers (2xx/4xx) are a
    // rendered service → commit; upstream failure (≥500/network) → rollback.
    // A failed phase-2 call is logged, never surfaced: the reservation is
    // healed by the facilitator's reaper (pro-customer direction).
    try {
      if (outcome.kind === "responded" && outcome.status < 500) {
        await verifier.commit(result.requestId, outcome.bytes);
      } else {
        await verifier.rollback(result.requestId);
      }
    } catch (err) {
      log({ level: "error", msg: "phase-2 call failed (reaper will heal)", requestId: result.requestId, error: err instanceof Error ? err.message : String(err) });
    }
    log({
      level: "info",
      msg: "paid request",
      method,
      path: pathname,
      requestId: result.requestId,
      amountSats: result.amountSats.toString(),
      upstreamStatus: outcome.kind === "responded" ? outcome.status : "unreachable",
    });
  }

  /** Pipe the request to the upstream origin and the response back. */
  function forward(
    req: IncomingMessage,
    res: ServerResponse,
    bufferedBody: Uint8Array | undefined,
    requestId: string | undefined,
  ): Promise<{ kind: "responded"; status: number; bytes: number } | { kind: "unreachable" }> {
    return new Promise((resolve) => {
      const client = upstream.protocol === "https:" ? https : http;
      const headers: Record<string, string | string[]> = {};
      for (const [name, value] of Object.entries(req.headers)) {
        if (value === undefined || HOP_BY_HOP.has(name)) continue;
        headers[name] = value;
      }
      headers["host"] = upstream.host;
      headers["x-forwarded-host"] = String(req.headers["host"] ?? "");
      headers["x-forwarded-proto"] = "http";
      const remote = req.socket.remoteAddress ?? "";
      headers["x-forwarded-for"] = req.headers["x-forwarded-for"] !== undefined ? `${String(req.headers["x-forwarded-for"])}, ${remote}` : remote;

      const upstreamReq = client.request(
        { protocol: upstream.protocol, hostname: upstream.hostname, port: upstream.port, path: req.url, method: req.method, headers },
        (upstreamRes) => {
          let bytes = 0;
          if (!res.headersSent) {
            for (const [name, value] of Object.entries(upstreamRes.headers)) {
              if (value === undefined || HOP_BY_HOP.has(name)) continue;
              res.setHeader(name, value);
            }
            res.writeHead(upstreamRes.statusCode ?? 502);
          }
          upstreamRes.on("data", (chunk: Buffer) => {
            bytes += chunk.length;
          });
          upstreamRes.pipe(res);
          upstreamRes.on("end", () => resolve({ kind: "responded", status: upstreamRes.statusCode ?? 502, bytes }));
          upstreamRes.on("error", () => resolve({ kind: "responded", status: upstreamRes.statusCode ?? 502, bytes }));
        },
      );
      upstreamReq.on("error", (err) => {
        log({ level: "error", msg: "upstream unreachable", error: err.message, ...(requestId !== undefined ? { requestId } : {}) });
        if (!res.headersSent) {
          sendJson(res, 502, { ok: false, error: { code: "upstream-unreachable", message: "origin did not answer" } });
        } else {
          res.destroy();
        }
        resolve({ kind: "unreachable" });
      });

      if (bufferedBody !== undefined) {
        upstreamReq.end(bufferedBody);
      } else {
        req.pipe(upstreamReq);
      }
    });
  }

  function discoveryDocument(): Record<string, unknown> {
    return {
      supportedVersions: [PROTOCOL_VERSION],
      defaultVersion: PROTOCOL_VERSION,
      deprecatedVersions: [],
      sunsetDates: {},
      supportedExtensions: ["scheme.bodyHash"],
      canonicalDomain: config.advertisement.canonicalDomain,
      network: config.advertisement.network,
      defaultScheme: SCHEME_VERUS_PREPAID_SIG,
      schemes: registry.supportedSchemes().map((scheme) => ({
        scheme,
        schemeVersion: registry.get(scheme)?.schemeVersions[0] ?? "0.1",
        network: config.advertisement.network,
        asset: config.advertisement.asset,
        payTo: config.advertisement.payTo,
      })),
      facilitator: config.facilitator.url,
      topup: {
        depositAddress: config.advertisement.payTo,
        attribution: "sender-verusid",
        instructionsEndpoint: `${config.facilitator.url.replace(/\/$/, "")}/v1/topup-instructions`,
      },
      endpoints: config.rules
        .filter((rule): rule is ProxyRule & { price: string } => rule.free !== true && rule.price !== undefined)
        .map((rule) => ({
          method: rule.method === undefined ? "*" : Array.isArray(rule.method) ? rule.method.join(",").toUpperCase() : rule.method.toUpperCase(),
          path: rule.match,
          amount: rule.price,
          amountUnit: "human",
          asset: config.advertisement.asset,
          bodyHashPolicy: rule.bodyHash,
        })),
    };
  }
}

function sendVerifyError(
  res: ServerResponse,
  registry: VerifierRegistry,
  advertisement: PaymentAdvertisement,
  policy: RoutePolicy,
  error: VerifyError,
): void {
  if (error.httpStatus === 402) {
    // 402s carry the full accepts array so clients can self-heal (M6)
    sendJson(res, 402, build402Body(advertisement, registry, policy, error));
    return;
  }
  sendJson(res, error.httpStatus, {
    ok: false,
    error: { code: error.code, message: error.message, ...(error.details !== undefined ? { details: error.details } : {}) },
  });
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(payload) });
  res.end(payload);
}

/** Consume and discard a request body we will not forward. */
function drain(req: IncomingMessage): void {
  req.resume();
}

/** Buffer up to `limit` bytes; undefined = limit exceeded. */
function readBody(req: IncomingMessage, limit: number): Promise<Uint8Array | undefined> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > limit) {
        req.removeAllListeners("data");
        req.resume();
        resolve(undefined);
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}
