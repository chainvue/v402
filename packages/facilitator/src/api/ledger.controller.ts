import { Controller, Get, HttpException, Inject, Query, Req } from "@nestjs/common";
import {
  canonicalizeLedgerQuery,
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

const MAX_PAGE = 100;

/**
 * GET /v1/ledger — the identity's STATEMENT ("Kontoauszug"): every ledger
 * entry (deposits, debits, refunds, reorg adjustments) with running
 * balances. Signature-authenticated exactly like /v1/balance, under its own
 * domain-separated context (`v402-ledger-query/0.1`); replay-protected via
 * spent_requests. Pagination (`afterId`, `limit`) is deliberately outside
 * the signature: it selects what the AUTHENTICATED owner sees, never who
 * may see it. Added 2026-07-14 from live agent feedback ("a bank account
 * without a Kontoauszug").
 */
@Controller("v1/ledger")
export class LedgerController {
  constructor(
    @Inject(V402_CONFIG) private readonly config: FacilitatorConfig,
    @Inject(STORAGE) private readonly storage: IStorage,
    @Inject(VERUS_RPC) private readonly rpc: IVerusRpc,
  ) {}

  @Get()
  async ledger(
    @Req() request: HeaderMap,
    @Query("afterId") afterIdRaw?: string,
    @Query("limit") limitRaw?: string,
  ): Promise<unknown> {
    const payer = single(request.headers, "x-v402-payer");
    const requestId = single(request.headers, "x-v402-request-id");
    const issuedAtRaw = single(request.headers, "x-v402-issued-at");
    const signature = single(request.headers, "x-v402-signature");

    if (!identitySchema.safeParse(payer).success) reject(400, "invalid-headers", "invalid X-V402-Payer");
    if (!isValidUlid(requestId)) reject(400, "invalid-headers", "X-V402-Request-Id must be a ULID");
    if (!/^(?:0|[1-9]\d*)$/.test(issuedAtRaw)) reject(400, "invalid-headers", "invalid X-V402-Issued-At");
    if (!isBase64Signature(signature)) reject(400, "invalid-headers", "X-V402-Signature must be standard Base64");

    const afterId = afterIdRaw === undefined ? undefined : Number(afterIdRaw);
    if (afterId !== undefined && (!Number.isSafeInteger(afterId) || afterId < 0)) {
      reject(400, "invalid-query", "afterId must be a non-negative integer");
    }
    const limit = limitRaw === undefined ? 50 : Number(limitRaw);
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_PAGE) {
      reject(400, "invalid-query", `limit must be an integer in [1, ${MAX_PAGE}]`);
    }

    const issuedAt = Number(issuedAtRaw);
    const now = Math.floor(Date.now() / 1000);
    if (Math.abs(now - issuedAt) > this.config.payment.timestampToleranceSec) {
      reject(400, "timestamp-out-of-window", "issuedAt outside the accepted window");
    }

    const canonical = canonicalizeLedgerQuery({
      canonicalDomain: this.config.payment.canonicalDomain,
      network: this.config.verus.chain,
      payer,
      requestId,
      issuedAt,
    });
    let valid: boolean;
    try {
      // checkLatest=true — same rule as the balance/payment paths: a
      // rotated-out or revoked primary key must not keep reading statements.
      valid = await this.rpc.verifyMessage(payer, signature, canonical, true);
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
      path: "/v1/ledger",
    });
    if (recorded.status === "replay") {
      reject(409, "replay", "requestId already spent", { previousStatus: recorded.previousStatus });
    }

    const entries = await this.storage.listLedgerEntries(identityKey, {
      ...(afterId !== undefined ? { afterId } : {}),
      limit,
    });
    const lastId = entries.length > 0 ? entries[entries.length - 1]!.id : null;
    return {
      identity: identityKey,
      entries: entries.map((entry) => ({
        id: entry.id,
        kind: entry.kind,
        reason: entry.reason,
        amount: satsToHuman(entry.amountSats),
        amountSats: entry.amountSats.toString(),
        balanceAfter: satsToHuman(entry.balanceAfterSats),
        balanceAfterSats: entry.balanceAfterSats.toString(),
        ...(entry.requestId !== undefined ? { requestId: entry.requestId } : {}),
        ...(entry.depositId !== undefined ? { depositId: entry.depositId } : {}),
        createdAt: entry.createdAt,
      })),
      count: entries.length,
      // Pass nextAfterId back as afterId to fetch the following page.
      ...(entries.length === limit && lastId !== null ? { nextAfterId: lastId } : {}),
    };
  }
}
