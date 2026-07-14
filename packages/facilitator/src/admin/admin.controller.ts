import { randomUUID } from "node:crypto";
import { Body, Controller, HttpException, Inject, Post, UseGuards } from "@nestjs/common";
import { PinoLogger } from "nestjs-pino";
import { z } from "zod";
import { SimulatedDepositWatcher, type IWatcher } from "@chainvue/v402-deposit-watcher";
import { humanAmountSchema, humanToSats, identitySchema, normalizeIdentityKey } from "@chainvue/v402-protocol";
import { StorageError, type IStorage } from "@chainvue/v402-storage";
import { STORAGE, WATCHER } from "../core/core.module.js";
import { parseBody } from "../api/dto.js";
import { ReconciliationService } from "../reconciliation/reconciliation.service.js";
import { AdminTokenGuard } from "./admin-token.guard.js";

/**
 * Balance-minting endpoints require operator attribution: /admin/* uses one
 * shared bearer token, so "who did this" must come from the request. The
 * value is persisted on the deposit row (`created_by`) and emitted as a
 * structured audit log line.
 */
const operatorSchema = z.string().min(1).max(100);

const creditBodySchema = z.object({
  identity: identitySchema,
  amount: humanAmountSchema,
  operator: operatorSchema,
  txid: z.string().min(1).optional(),
  note: z.string().max(500).optional(),
});

const simulateDepositBodySchema = z.object({
  identity: identitySchema,
  amount: humanAmountSchema,
  operator: operatorSchema,
  txid: z.string().min(1).optional(),
  note: z.string().max(500).optional(),
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
    @Inject(PinoLogger) private readonly logger: PinoLogger,
  ) {
    this.logger.setContext("admin-audit");
  }

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
        createdBy: body.operator,
        ...(body.txid !== undefined ? { txid: body.txid } : {}),
        ...(body.note !== undefined ? { note: body.note } : {}),
      });
      this.logger.info(
        {
          event: "admin.simulate-deposit",
          operator: body.operator,
          identity: result.deposit.identityId,
          amountSats: result.deposit.amountSats.toString(),
          depositId: result.deposit.id,
          txid: result.deposit.txid,
        },
        "admin simulated deposit credited",
      );
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
      // recorded as origin=simulated so the on-chain crosscheck never counts
      // it; insert + credit run in ONE storage transaction — a crash can
      // never leave a spendable-looking uncredited row behind
      const result = await this.storage.insertAndCreditDeposit(
        {
          identityId: identityKey,
          amountSats: humanToSats(body.amount),
          currency: "VRSCTEST",
          txid: body.txid ?? `admin-credit-${randomUUID()}`,
          vout: 0,
          blockHeight: 0,
          blockHash: "admin",
          confirmations: 0,
          detectedAt: now,
          origin: "simulated",
          createdBy: body.operator,
          ...(body.note !== undefined ? { note: body.note } : {}),
        },
        now,
      );
      this.logger.info(
        {
          event: "admin.credit",
          operator: body.operator,
          identity: identityKey,
          amountSats: result.deposit.amountSats.toString(),
          depositId: result.deposit.id,
          txid: result.deposit.txid,
          note: body.note,
        },
        "admin manual credit applied",
      );
      return {
        ok: true,
        deposit: { id: result.deposit.id, txid: result.deposit.txid, origin: result.deposit.origin },
        identity: identityKey,
        balanceAfterSats: result.balanceAfterSats.toString(),
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
