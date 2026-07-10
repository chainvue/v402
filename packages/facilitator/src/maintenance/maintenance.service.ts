import { Inject, Injectable, type OnApplicationBootstrap } from "@nestjs/common";
import { Interval, SchedulerRegistry } from "@nestjs/schedule";
import { InjectMetric } from "@willsoto/nestjs-prometheus";
import { CronJob } from "cron";
import { PinoLogger } from "nestjs-pino";
import type { Gauge } from "prom-client";
import type { IWatcher } from "@chainvue/v402-deposit-watcher";
import type { IStorage } from "@chainvue/v402-storage";
import { VerusRpcClient, type IVerusRpc } from "@chainvue/v402-verus-rpc";
import { V402_CONFIG } from "../config/config.module.js";
import type { FacilitatorConfig } from "../config/schema.js";
import { STORAGE, VERUS_RPC, WATCHER } from "../core/core.module.js";
import { ReconciliationService } from "../reconciliation/reconciliation.service.js";

const CIRCUIT_STATE_VALUES: Record<string, number> = { closed: 0, "half-open": 1, open: 2, isolated: 2 };

/**
 * Background jobs (plan §§ Two-phase debit, Replay protection, Balance
 * Reconciliation):
 * - reaper (60s): refund `reserved` requests older than reserveTtlSec (B3)
 * - cleanup (60s): purge spent_requests older than the retention horizon —
 *   the horizon MUST exceed both reserveTtl and the timestamp window, so a
 *   purged requestId can never be replayed inside the acceptance window
 * - watcher/circuit gauges (15s)
 * - reconciliation cron (config expression, default 03:00 UTC daily)
 */
@Injectable()
export class MaintenanceService implements OnApplicationBootstrap {
  private readonly cleanupHorizonSec: number;

  constructor(
    @Inject(V402_CONFIG) private readonly config: FacilitatorConfig,
    @Inject(STORAGE) private readonly storage: IStorage,
    @Inject(WATCHER) private readonly watcher: IWatcher,
    @Inject(VERUS_RPC) private readonly rpc: IVerusRpc,
    @Inject(ReconciliationService) private readonly reconciliation: ReconciliationService,
    @Inject(SchedulerRegistry) private readonly scheduler: SchedulerRegistry,
    @Inject(PinoLogger) private readonly logger: PinoLogger,
    @InjectMetric("v402_watcher_lag_blocks") private readonly watcherLag: Gauge,
    @InjectMetric("v402_circuit_state") private readonly circuitState: Gauge,
  ) {
    this.logger.setContext(MaintenanceService.name);
    // plan default 600s; scale with config so cleanup can never undercut the
    // reaper or the replay window (invariant from RISKS.md step 14)
    this.cleanupHorizonSec = Math.max(
      600,
      2 * Math.max(this.config.payment.reserveTtlSec, this.config.payment.timestampToleranceSec),
    );
  }

  onApplicationBootstrap(): void {
    if (!this.config.reconciliation.enabled) return;
    const job = new CronJob(this.config.reconciliation.cron, () => {
      void this.runReconciliation();
    });
    this.scheduler.addCronJob("reconciliation", job);
    job.start();
  }

  @Interval("reaper", 60_000)
  async runReaper(): Promise<string[]> {
    const now = Math.floor(Date.now() / 1000);
    const reaped = await this.storage.reapExpiredReservations(now - this.config.payment.reserveTtlSec, now);
    if (reaped.length > 0) {
      this.logger.warn({ count: reaped.length, requestIds: reaped }, "reaper refunded expired reservations");
    }
    return reaped;
  }

  @Interval("cleanup", 60_000)
  async runCleanup(): Promise<number> {
    const now = Math.floor(Date.now() / 1000);
    const removed = await this.storage.cleanupSpentRequests(now - this.cleanupHorizonSec);
    if (removed > 0) {
      this.logger.debug({ removed, horizonSec: this.cleanupHorizonSec }, "purged expired spent_requests");
    }
    return removed;
  }

  @Interval("watcher-metrics", 15_000)
  updateGauges(): void {
    const status = this.watcher.status();
    if (status.lagBlocks !== undefined) this.watcherLag.set(status.lagBlocks);
    if (this.rpc instanceof VerusRpcClient) {
      this.circuitState.set({ name: "verus-rpc" }, CIRCUIT_STATE_VALUES[this.rpc.circuitState()] ?? 2);
    }
  }

  async runReconciliation(): Promise<void> {
    try {
      const result = await this.reconciliation.run();
      if (result.mismatches > 0) {
        this.logger.error({ mismatches: result.mismatches, detail: result.detail }, "reconciliation found mismatches");
      } else {
        this.logger.info(
          { identitiesChecked: result.identitiesChecked, durationMs: result.durationMs },
          "reconciliation clean",
        );
      }
    } catch (err) {
      this.logger.error({ err }, "reconciliation run failed");
    }
  }
}
