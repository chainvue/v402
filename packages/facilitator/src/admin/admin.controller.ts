import { randomUUID } from "node:crypto";
import { Body, Controller, HttpException, Inject, Post, UseGuards } from "@nestjs/common";
import { z } from "zod";
import { SimulatedDepositWatcher, type IWatcher } from "@chainvue/v402-deposit-watcher";
import { humanAmountSchema, humanToSats, identitySchema, normalizeIdentityKey } from "@chainvue/v402-protocol";
import { StorageError, type IStorage } from "@chainvue/v402-storage";
import { STORAGE, WATCHER } from "../core/core.module.js";
import { parseBody } from "../api/dto.js";
import { ReconciliationService } from "../reconciliation/reconciliation.service.js";
import { AdminTokenGuard } from "./admin-token.guard.js";

const creditBodySchema = z.object({
  identity: identitySchema,
  amount: humanAmountSchema,
  txid: z.string().min(1).optional(),
  note: z.string().max(500).optional(),
});

const simulateDepositBodySchema = z.object({
  identity: identitySchema,
  amount: humanAmountSchema,
  txid: z.string().min(1).optional(),
});

/**
 * Operator endpoints (plan step 15), Bearer admin token required.
 * simulate-deposit only works in simulated watcher mode; credit works in
 * any mode as the support tool for missed deposits ("manual credit
 * endpoint for support", risk table).
 */
@Controller("admin")
@UseGuards(AdminTokenGuard)
export class AdminController {
  constructor(
    @Inject(STORAGE) private readonly storage: IStorage,
    @Inject(WATCHER) private readonly watcher: IWatcher,
    @Inject(ReconciliationService) private readonly reconciliation: ReconciliationService,
  ) {}

  @Post("simulate-deposit")
  async simulateDeposit(@Body() rawBody: unknown): Promise<unknown> {
    const body = parseBody(simulateDepositBodySchema, rawBody);
    if (!(this.watcher instanceof SimulatedDepositWatcher)) {
      throw new HttpException(
        { ok: false, error: { code: "not-simulated", message: "simulate-deposit requires watcher.mode=simulated" } },
        409,
      );
    }
    try {
      const result = await this.watcher.simulateDeposit({
        identity: body.identity,
        amountSats: humanToSats(body.amount),
        ...(body.txid !== undefined ? { txid: body.txid } : {}),
      });
      return {
        ok: true,
        deposit: { id: result.deposit.id, txid: result.deposit.txid, origin: result.deposit.origin },
        identity: result.deposit.identityId,
        balanceAfterSats: result.balanceAfterSats.toString(),
      };
    } catch (err) {
      if (err instanceof StorageError && err.code === "duplicate-deposit") {
        throw new HttpException({ ok: false, error: { code: "duplicate-deposit", message: err.message } }, 409);
      }
      throw err;
    }
  }

  @Post("credit")
  async credit(@Body() rawBody: unknown): Promise<unknown> {
    const body = parseBody(creditBodySchema, rawBody);
    const identityKey = normalizeIdentityKey(body.identity);
    const now = Math.floor(Date.now() / 1000);
    try {
      // recorded as origin=simulated so the on-chain crosscheck never counts it
      const deposit = await this.storage.insertDeposit({
        identityId: identityKey,
        amountSats: humanToSats(body.amount),
        currency: "VRSCTEST",
        txid: body.txid ?? `admin-credit-${randomUUID()}`,
        vout: 0,
        blockHeight: 0,
        blockHash: body.note !== undefined ? `admin:${body.note}` : "admin",
        confirmations: 0,
        detectedAt: now,
        origin: "simulated",
      });
      const credited = await this.storage.creditDeposit(deposit.id, now);
      if (!credited.ok) {
        throw new HttpException({ ok: false, error: { code: "credit-failed", message: credited.reason } }, 500);
      }
      return {
        ok: true,
        deposit: { id: deposit.id, txid: deposit.txid, origin: deposit.origin },
        identity: identityKey,
        balanceAfterSats: credited.balanceAfterSats.toString(),
      };
    } catch (err) {
      if (err instanceof StorageError && err.code === "duplicate-deposit") {
        throw new HttpException({ ok: false, error: { code: "duplicate-deposit", message: err.message } }, 409);
      }
      throw err;
    }
  }

  @Post("reconcile")
  async reconcile(): Promise<unknown> {
    const result = await this.reconciliation.run();
    return { ok: true, ...result };
  }
}
