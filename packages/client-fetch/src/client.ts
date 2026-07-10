import {
  canonicalizeBalanceQuery,
  discoveryDocumentSchema,
  type DiscoveryDocument,
} from "@chainvue/v402-protocol";
import type { HeightProvider, Signer } from "@chainvue/v402-signer-verus";
import { V402ClientError } from "./errors.js";
import { paidFetch, resolveConfig, type PaymentFetchConfig } from "./handshake.js";
import { ulid } from "./ulid.js";

export interface V402ClientOptions extends Omit<PaymentFetchConfig, "payer" | "signer"> {
  /** VerusID this client pays as. */
  identity: string;
  signer: Signer;
  /** Facilitator base URL (balance, topup, discovery). */
  facilitator: string;
  fetchImpl?: typeof fetch;
}

export interface BalanceInfo {
  identity: string;
  balance: string;
  reserved: string;
  available: string;
  balanceSats: string;
  reservedSats: string;
  availableSats: string;
  firstDepositAt?: number;
  lastRequestAt?: number;
}

/**
 * The full-featured client (plan § Client Library Surface): paid fetch plus
 * balance, topup and discovery conveniences over the same signer/facilitator
 * abstractions.
 */
export class V402Client {
  private readonly options: V402ClientOptions;
  private readonly fetchImpl: typeof fetch;
  private readonly facilitatorBase: string;
  private facilitatorDiscovery: (DiscoveryDocument & { canonicalDomain?: string; network?: string }) | undefined;

  constructor(options: V402ClientOptions) {
    this.options = options;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.facilitatorBase = options.facilitator.replace(/\/$/, "");
  }

  /** Paid fetch — wrapFetchWithPayment semantics. */
  fetch(url: string | URL, init?: RequestInit): Promise<Response> {
    const { identity, signer, facilitator: _f, fetchImpl: _i, ...rest } = this.options;
    return paidFetch(this.fetchImpl, url, init, resolveConfig({ payer: identity, signer, ...rest }));
  }

  /** `.well-known/v402` of the given base URL (or the facilitator). Cached for the facilitator. */
  async discover(baseUrl?: string): Promise<DiscoveryDocument> {
    const base = (baseUrl ?? this.facilitatorBase).replace(/\/$/, "");
    if (base === this.facilitatorBase && this.facilitatorDiscovery !== undefined) return this.facilitatorDiscovery;
    const response = await this.fetchImpl(`${base}/.well-known/v402`);
    if (!response.ok) {
      throw new V402ClientError("facilitator-error", `discovery failed: HTTP ${response.status}`);
    }
    const parsed = discoveryDocumentSchema.safeParse(await response.json());
    if (!parsed.success) {
      throw new V402ClientError("facilitator-error", "discovery document does not match the v402 schema");
    }
    const document = parsed.data as DiscoveryDocument & { canonicalDomain?: string; network?: string };
    if (base === this.facilitatorBase) this.facilitatorDiscovery = document;
    return document;
  }

  /** Signed balance query (domain-separated v402-balance-query payload, replay-protected). */
  async getBalance(): Promise<BalanceInfo> {
    const discovery = (await this.discover()) as { canonicalDomain?: string; network?: string };
    if (discovery.canonicalDomain === undefined || discovery.network === undefined) {
      throw new V402ClientError("facilitator-error", "facilitator discovery lacks canonicalDomain/network");
    }
    const requestId = ulid();
    const issuedAt = Math.floor(Date.now() / 1000);
    const signature = await this.options.signer.signMessage(
      canonicalizeBalanceQuery({
        canonicalDomain: discovery.canonicalDomain,
        network: discovery.network,
        payer: this.options.identity,
        requestId,
        issuedAt,
      }),
    );
    const response = await this.fetchImpl(`${this.facilitatorBase}/v1/balance`, {
      headers: {
        "X-V402-Payer": this.options.identity,
        "X-V402-Request-Id": requestId,
        "X-V402-Issued-At": String(issuedAt),
        "X-V402-Signature": signature,
      },
    });
    const body = (await response.json()) as BalanceInfo & { error?: { code?: string; message?: string } };
    if (!response.ok) {
      throw new V402ClientError("facilitator-error", `balance query failed: ${body.error?.code ?? response.status}`, {
        status: response.status,
        ...(body.error !== undefined ? { error: body.error } : {}),
      });
    }
    return body;
  }

  /** Public topup instructions (payment URI + QR) for this client's identity. */
  async getTopupInstructions(options: { amount?: string } = {}): Promise<Record<string, unknown>> {
    const query = new URLSearchParams({ identity: this.options.identity });
    if (options.amount !== undefined) query.set("amount", options.amount);
    const response = await this.fetchImpl(`${this.facilitatorBase}/v1/topup-instructions?${query.toString()}`);
    const body = (await response.json()) as Record<string, unknown>;
    if (!response.ok) {
      throw new V402ClientError("facilitator-error", `topup instructions failed: HTTP ${response.status}`);
    }
    return body;
  }
}

/**
 * HeightProvider for local identity signers (EnvSigner/FileSigner with
 * `identity` mode): reads the current chain height from the facilitator's
 * public health endpoint — no Verus node needed on the client.
 */
export function facilitatorHeightProvider(facilitatorUrl: string, fetchImpl: typeof fetch = fetch): HeightProvider {
  const base = facilitatorUrl.replace(/\/$/, "");
  return async () => {
    const response = await fetchImpl(`${base}/v1/health`);
    const body = (await response.json()) as { verusRpc?: { blocks?: number } };
    const blocks = body.verusRpc?.blocks;
    if (typeof blocks !== "number" || blocks <= 0) {
      throw new V402ClientError("facilitator-error", "facilitator health reports no chain height");
    }
    return blocks;
  };
}
