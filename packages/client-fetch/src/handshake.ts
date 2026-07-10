import { createHash } from "node:crypto";
import {
  SCHEME_VERUS_PREPAID_SIG,
  V402_HEADERS,
  canonicalize,
  paymentRequirementSchema,
  payment402ResponseSchema,
  serializeExtensionBlock,
  type ExtensionField,
  type PaymentRequirement,
} from "@chainvue/v402-protocol";
import type { Signer } from "@chainvue/v402-signer-verus";
import { V402ClientError } from "./errors.js";
import { ulid } from "./ulid.js";

export interface PaymentFetchConfig {
  /** VerusID the requests are paid as (X-V402-Payer, signed into the payload). */
  payer: string;
  signer: Signer;
  /**
   * Transient retries with the SAME requestId (M5: network failure, 503, 429
   * — no definitive answer / nothing reserved). Default 2.
   */
  maxRetries?: number;
  /** price-mismatch recoveries (fresh ULID, re-signed at the new price). Default 1. */
  priceMismatchRetries?: number;
  /** Attach scheme.bodyHash for body-carrying requests. Default "auto". */
  bodyHash?: "auto" | "never";
  /** Cap on honoring Retry-After. Default 5000ms. */
  maxRetryAfterMs?: number;
  /** Injectable for tests. */
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

type ResolvedConfig = Required<PaymentFetchConfig>;

export function resolveConfig(config: PaymentFetchConfig): ResolvedConfig {
  return {
    maxRetries: 2,
    priceMismatchRetries: 1,
    bodyHash: "auto",
    maxRetryAfterMs: 5000,
    sleep: (ms: number) => new Promise((resolve) => setTimeout(resolve, ms)),
    now: () => Math.floor(Date.now() / 1000),
    ...config,
  };
}

function bodyBytes(body: RequestInit["body"]): Uint8Array | undefined {
  if (body === undefined || body === null) return undefined;
  if (typeof body === "string") return Buffer.from(body, "utf8");
  if (body instanceof Uint8Array) return body;
  if (body instanceof ArrayBuffer) return new Uint8Array(body);
  throw new V402ClientError(
    "unsupported-body-type",
    "v402 bodyHash needs raw bytes — pass the body as string, Uint8Array or ArrayBuffer (or set bodyHash: 'never')",
  );
}

async function parse402(response: Response): Promise<{ requirement: PaymentRequirement; errorCode?: string }> {
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    throw new V402ClientError("invalid-402-response", "402 response body is not JSON");
  }
  const envelope = payment402ResponseSchema.safeParse(body);
  if (!envelope.success) {
    throw new V402ClientError("invalid-402-response", "402 response does not match the v402 envelope");
  }
  const entry = envelope.data.accepts.find((a) => a.scheme === SCHEME_VERUS_PREPAID_SIG);
  if (!entry) {
    throw new V402ClientError("no-supported-scheme", "server accepts no scheme this client supports", {
      offered: envelope.data.accepts.map((a) => a.scheme),
    });
  }
  const requirement = paymentRequirementSchema.safeParse(entry);
  if (!requirement.success) {
    throw new V402ClientError("invalid-402-response", "verus-prepaid-sig accepts entry is malformed");
  }
  const errorCode = (body as { error?: { code?: string } }).error?.code;
  return { requirement: requirement.data as PaymentRequirement, ...(errorCode !== undefined ? { errorCode } : {}) };
}

function retryAfterMs(response: Response, cap: number): number {
  const header = response.headers.get("retry-after");
  const seconds = header !== null ? Number(header) : NaN;
  return Math.min(Number.isFinite(seconds) && seconds >= 0 ? seconds * 1000 : 1000, cap);
}

/**
 * The 402 handshake (spec § Payment Flow, client side):
 * plain request → 402 challenge → sign the canonical payload for the
 * advertised requirement → resend with X-V402-* headers. Retry semantics
 * follow the normative M5 table:
 * - network error / 503 / 429 → SAME requestId + same signature (idempotent
 *   reserve; a fresh ULID here risks double-pay)
 * - 402 price-mismatch → FRESH ULID, re-signed with the accepts of that
 *   response (M6 self-healing)
 * - 409 and endpoint errors are definitive answers → returned to the caller
 *   (an endpoint 5xx was rolled back server-side; retrying is the caller's
 *   business decision, not the transport's)
 */
export async function paidFetch(
  fetchImpl: typeof fetch,
  url: string | URL,
  init: RequestInit | undefined,
  config: ResolvedConfig,
): Promise<Response> {
  const first = await fetchImpl(url, init);
  if (first.status !== 402) return first;

  let { requirement } = await parse402(first);
  for (let recovery = 0; ; recovery++) {
    const response = await sendPaid(fetchImpl, url, init, requirement, config);
    if (response.status === 402 && recovery < config.priceMismatchRetries) {
      const parsed = await parse402(response.clone());
      if (parsed.errorCode === "price-mismatch") {
        requirement = parsed.requirement; // current accepts from the M6 response
        continue;
      }
    }
    return response;
  }
}

async function sendPaid(
  fetchImpl: typeof fetch,
  url: string | URL,
  init: RequestInit | undefined,
  requirement: PaymentRequirement,
  config: ResolvedConfig,
): Promise<Response> {
  const target = new URL(url);
  // M1: build the request-target once, sign it, and send the identical string
  const path = `${target.pathname}${target.search}`;
  const method = (init?.method ?? "GET").toUpperCase();
  const bytes = bodyBytes(init?.body);

  const extensions: ExtensionField[] = [];
  if (config.bodyHash === "auto" && bytes !== undefined && bytes.byteLength > 0) {
    extensions.push({ key: "scheme.bodyHash", value: `sha256:${createHash("sha256").update(bytes).digest("hex")}` });
  }

  const requestId = ulid();
  const issuedAt = config.now();
  const canonical = canonicalize({
    scheme: requirement.scheme,
    schemeVersion: requirement.schemeVersion,
    canonicalDomain: requirement.canonicalDomain,
    method,
    path,
    network: requirement.network,
    asset: requirement.asset,
    amount: requirement.amount, // byte-verbatim from the 402
    payer: config.payer,
    payTo: requirement.payTo,
    requestId,
    issuedAt,
    ...(extensions.length > 0 ? { extensions } : {}),
  });
  const signature = await config.signer.signMessage(canonical);

  const headers = new Headers(init?.headers);
  headers.set(V402_HEADERS.scheme, requirement.scheme);
  headers.set(V402_HEADERS.payer, config.payer);
  headers.set(V402_HEADERS.amount, requirement.amount);
  headers.set(V402_HEADERS.requestId, requestId);
  headers.set(V402_HEADERS.issuedAt, String(issuedAt));
  headers.set(V402_HEADERS.signature, signature);
  if (extensions.length > 0) {
    headers.set(V402_HEADERS.extensions, Buffer.from(serializeExtensionBlock(extensions), "utf8").toString("base64"));
  }
  const paidInit: RequestInit = { ...init, method, headers };

  // transient retries: SAME requestId, same signature — reserve is idempotent (M5)
  let lastError: unknown;
  for (let attempt = 0; attempt <= config.maxRetries; attempt++) {
    let response: Response;
    try {
      response = await fetchImpl(target, paidInit);
    } catch (err) {
      lastError = err;
      continue;
    }
    if ((response.status === 503 || response.status === 429) && attempt < config.maxRetries) {
      await config.sleep(retryAfterMs(response, config.maxRetryAfterMs));
      continue;
    }
    return response;
  }
  throw new V402ClientError("retries-exhausted", "request failed after transient retries", {
    requestId,
    cause: lastError instanceof Error ? lastError.message : String(lastError),
  });
}
