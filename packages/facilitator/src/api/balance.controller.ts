import { Controller, Get, HttpException, Inject, Req } from "@nestjs/common";
import {
  canonicalizeBalanceQuery,
  identitySchema,
  isBase64Signature,
  isValidUlid,
  normalizeIdentityKey,
  satsToHuman,
} from "@chainvue/v402-protocol";
import type { IStorage } from "@chainvue/v402-storage";
import { VerusRpcUnavailableError, type IVerusRpc } from "@chainvue/v402-verus-rpc";
import { V402_CONFIG } from "../config/config.module.js";
import type { FacilitatorConfig } from "../config/schema.js";
import { STORAGE, VERUS_RPC } from "../core/core.module.js";

interface HeaderMap {
  headers: Record<string, string | string[] | undefined>;
}

function reject(httpStatus: number, code: string, message: string, details?: Record<string, unknown>): never {
  throw new HttpException({ ok: false, error: { code, message, ...(details ? { details } : {}) } }, httpStatus);
}

function single(headers: HeaderMap["headers"], name: string): string {
  const value = headers[name];
  if (value === undefined) reject(400, "invalid-headers", `missing required header: ${name}`);
  if (Array.isArray(value)) reject(400, "invalid-headers", `header must not repeat: ${name}`);
  return value;
}

/**
 * GET /v1/balance — signature-authenticated (plan § Topup Instructions
 * Endpoint): the client signs the domain-separated `v402-balance-query/0.1`
 * canonical payload, so only the identity owner can read their balance.
 * Replay-protected via spent_requests (amount 0, committed).
 */
@Controller("v1/balance")
export class BalanceController {
  constructor(
    @Inject(V402_CONFIG) private readonly config: FacilitatorConfig,
    @Inject(STORAGE) private readonly storage: IStorage,
    @Inject(VERUS_RPC) private readonly rpc: IVerusRpc,
  ) {}

  @Get()
  async balance(@Req() request: HeaderMap): Promise<unknown> {
    const payer = single(request.headers, "x-v402-payer");
    const requestId = single(request.headers, "x-v402-request-id");
    const issuedAtRaw = single(request.headers, "x-v402-issued-at");
    const signature = single(request.headers, "x-v402-signature");

    if (!identitySchema.safeParse(payer).success) reject(400, "invalid-headers", "invalid X-V402-Payer");
    if (!isValidUlid(requestId)) reject(400, "invalid-headers", "X-V402-Request-Id must be a ULID");
    if (!/^(?:0|[1-9]\d*)$/.test(issuedAtRaw)) reject(400, "invalid-headers", "invalid X-V402-Issued-At");
    if (!isBase64Signature(signature)) reject(400, "invalid-headers", "X-V402-Signature must be standard Base64");

    const issuedAt = Number(issuedAtRaw);
    const now = Math.floor(Date.now() / 1000);
    if (Math.abs(now - issuedAt) > this.config.payment.timestampToleranceSec) {
      reject(400, "timestamp-out-of-window", "issuedAt outside the accepted window");
    }

    const canonical = canonicalizeBalanceQuery({
      canonicalDomain: this.config.payment.canonicalDomain,
      network: this.config.verus.chain,
      payer,
      requestId,
      issuedAt,
    });
    let valid: boolean;
    try {
      valid = await this.rpc.verifyMessage(payer, signature, canonical);
    } catch (err) {
      if (err instanceof VerusRpcUnavailableError) {
        reject(503, "verify-unavailable", "signature verification temporarily unavailable");
      }
      valid = false; // daemon app error — semantic reject
    }
    if (!valid) reject(402, "invalid-signature", "signature verification failed");

    const identityKey = normalizeIdentityKey(payer);
    const recorded = await this.storage.recordBalanceQuery({
      requestId,
      identityId: identityKey,
      issuedAt,
      receivedAt: now,
      method: "GET",
      path: "/v1/balance",
    });
    if (recorded.status === "replay") {
      reject(409, "replay", "requestId already spent", { previousStatus: recorded.previousStatus });
    }

    const account = await this.storage.getIdentity(identityKey);
    const availableSats = account?.balanceSats ?? 0n;
    const reservedSats = await this.storage.sumReservedSats(identityKey);
    const balanceSats = availableSats + reservedSats;
    return {
      identity: identityKey,
      balance: satsToHuman(balanceSats),
      reserved: satsToHuman(reservedSats),
      available: satsToHuman(availableSats),
      balanceSats: balanceSats.toString(),
      reservedSats: reservedSats.toString(),
      availableSats: availableSats.toString(),
      // schema tracks the FIRST deposit (plan data model); the plan's response
      // example says lastDepositAt — deliberate deviation, see RISKS.md
      ...(account?.firstDepositAt !== undefined ? { firstDepositAt: account.firstDepositAt } : {}),
      ...(account?.lastRequestAt !== undefined ? { lastRequestAt: account.lastRequestAt } : {}),
    };
  }
}
