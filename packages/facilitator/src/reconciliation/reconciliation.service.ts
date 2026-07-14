import { Inject, Injectable } from "@nestjs/common";
import { InjectMetric } from "@willsoto/nestjs-prometheus";
import type { Counter, Gauge } from "prom-client";
import { humanToSats } from "@chainvue/v402-protocol";
import type { IStorage } from "@chainvue/v402-storage";
import type { IVerusRpc } from "@chainvue/v402-verus-rpc";
import { V402_CONFIG } from "../config/config.module.js";
import type { FacilitatorConfig } from "../config/schema.js";
import { STORAGE, VERUS_RPC } from "../core/core.module.js";
import { hashIdentity } from "../logging/identity-hash.js";

export interface ReconciliationMismatch {
  identityHash: string;
  balanceSats: string;
  ledgerSumSats: string;
  ledgerLatestBalanceAfterSats: string | null;
}

export interface ReconciliationResult {
  runAt: number;
  identitiesChecked: number;
  mismatches: number;
  detail: ReconciliationMismatch[];
  /**
   * Advisory on-chain crosscheck (plan § Balance Reconciliation): credited
   * real-deposit ledger sum vs the payTo identity's on-chain balance. NOT
   * counted as a mismatch: it assumes a dedicated identity AND a watcher
   * history from that identity's first deposit — neither holds for a
   * tip-bootstrapped watcher. Alert on drift manually until then.
   */
  onChain: { available: false } | { available: true; creditedDepositSats: string; chainBalanceSats: string };
  durationMs: number;
}

/**
 * Verifies the B1 ledger invariants per identity:
 *   balance == sum(ledger.amount) == balance_after of the latest ledger row.
 * The ledger is the source of truth — spent_requests is purged after 10min
 * and unusable for accounting. Cron wiring comes in step 16; the admin
 * endpoint triggers runs on demand.
 */
@Injectable()
export class ReconciliationService {
  constructor(
    @Inject(V402_CONFIG) private readonly config: FacilitatorConfig,
    @Inject(STORAGE) private readonly storage: IStorage,
    @Inject(VERUS_RPC) private readonly rpc: IVerusRpc,
    @InjectMetric("v402_reconciliation_mismatch_total") private readonly mismatchTotal: Counter,
    @InjectMetric("v402_reconciliation_last_ok_timestamp") private readonly lastOk: Gauge,
  ) {}

  async run(): Promise<ReconciliationResult> {
    const startedAt = Date.now();
    const runAt = Math.floor(startedAt / 1000);
    const detail: ReconciliationMismatch[] = [];

    const identityIds = await this.storage.listIdentityIds();
    for (const identityId of identityIds) {
      const identity = await this.storage.getIdentity(identityId);
      if (!identity) continue;
      const summary = await this.storage.getLedgerSummary(identityId);
      const sumOk = summary.sumSats === identity.balanceSats;
      const latestOk = summary.latestBalanceAfterSats === identity.balanceSats;
      if (!sumOk || !latestOk) {
        detail.push({
          identityHash: hashIdentity(identityId, this.config.logging.identityHashLength),
          balanceSats: identity.balanceSats.toString(),
          ledgerSumSats: summary.sumSats.toString(),
          ledgerLatestBalanceAfterSats: summary.latestBalanceAfterSats?.toString() ?? null,
        });
      }
    }

    let onChain: ReconciliationResult["onChain"] = { available: false };
    try {
      const payTo = this.config.schemes[0]!.config.payToIdentity;
      const asset = this.config.schemes[0]!.config.asset;
      const balance = await this.rpc.getCurrencyBalance(payTo);
      const chainCoins = typeof balance === "number" ? balance : (balance[asset] ?? 0);
      onChain = {
        available: true,
        creditedDepositSats: (await this.storage.sumCreditedDeposits({ excludeSimulated: true })).toString(),
        // ADVISORY ONLY: chainCoins arrives as a JSON float from the RPC, so
        // this figure is inexact by construction and never counted as a
        // mismatch. If this crosscheck is ever promoted to a hard check, the
        // FIRST prerequisite is an exact chain-side amount source (e.g.
        // getaddressutxos satoshi sums), not this float round-trip.
        chainBalanceSats: humanToSats(chainCoins.toFixed(8).replace(/0+$/, "").replace(/\.$/, "") || "0").toString(),
      };
    } catch {
      // node unreachable — the per-identity invariants above are the hard check
    }

    const durationMs = Date.now() - startedAt;
    const result: ReconciliationResult = {
      runAt,
      identitiesChecked: identityIds.length,
      mismatches: detail.length,
      detail,
      onChain,
      durationMs,
    };
    await this.storage.recordReconciliationRun({
      runAt,
      identitiesChecked: result.identitiesChecked,
      mismatches: result.mismatches,
      detailJson: JSON.stringify({ detail, onChain }),
      durationMs,
    });
    if (result.mismatches > 0) {
      this.mismatchTotal.inc(result.mismatches);
    } else {
      this.lastOk.set(runAt);
    }
    return result;
  }
}
