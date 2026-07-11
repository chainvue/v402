import type { IStorage } from "@chainvue/v402-storage";
import type { IVerusRpc, VerusRpcConfig } from "@chainvue/v402-verus-rpc";
import type { SchemeVerifier } from "@chainvue/v402-verifier";

/** Fields advertised in 402 responses (the `accepts` entry, minus per-route price). */
export interface PaymentAdvertisement {
  /** Domain signatures are bound to — MUST match what clients see. */
  canonicalDomain: string;
  /** e.g. "vrsctest" (M3). */
  network: string;
  /** e.g. "VRSCTEST". */
  asset: string;
  /** Receiving identity (also the deposit address). */
  payTo: string;
  /** Facilitator base URL advertised to clients (topup/balance endpoints). */
  facilitatorUrl: string;
}

/** Options shared by both adapter modes beyond the advertisement fields. */
export interface V402SharedOptions {
  /**
   * Serve `GET /.well-known/v402` with the schemes/topup advertisement and
   * an `endpoints` rate card derived from @V402Payment metadata (single
   * source of truth). Default true; set false if the app provides its own
   * discovery document.
   */
  discovery?: boolean;
}

export interface V402InProcessOptions extends PaymentAdvertisement, V402SharedOptions {
  mode?: "in-process";
  db: { path: string; walMode?: boolean };
  verus: Pick<VerusRpcConfig, "rpcUrl" | "rpcUser" | "rpcPass" | "circuit">;
  timestampToleranceSec?: number;
  maxExtensionsBytes?: number;
  /** Test seams — replace the internally constructed stack. */
  storage?: IStorage;
  verusRpc?: IVerusRpc;
}

export interface V402HttpOptions extends PaymentAdvertisement, V402SharedOptions {
  mode: "http";
  /**
   * URL the middleware itself calls (e.g. http://facilitator:3000 inside
   * compose). Defaults to `facilitatorUrl` — but the advertised URL is what
   * CLIENTS reach, which may differ from the in-cluster address.
   */
  facilitatorInternalUrl?: string;
  /** Per-middleware token provisioned by the facilitator operator. */
  facilitatorAuthToken: string;
  /** Identifies this middleware in the facilitator's logs (Basic username). */
  middlewareId?: string;
  fetchImpl?: typeof fetch;
}

export type V402ModuleOptions = V402InProcessOptions | V402HttpOptions;

/** Per-route payment requirement set by @V402Payment. */
export interface RoutePaymentMetadata {
  priceHuman: string;
  bodyHashPolicy: "required" | "optional" | "ignored";
}

/** Attached to the request by the PaymentGuard; consumed by the PaymentInterceptor. */
export interface V402RequestContext {
  requestId: string;
  payer: string;
  amountSats: bigint;
  balanceAfterSats: bigint;
  scheme: string;
  verifier: SchemeVerifier;
}

export const V402_CONTEXT = Symbol("v402Context");

export interface RequestWithV402 {
  method: string;
  originalUrl?: string;
  url?: string;
  headers: Record<string, string | string[] | undefined>;
  rawBody?: Uint8Array;
  [V402_CONTEXT]?: V402RequestContext;
}
