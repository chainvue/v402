import { Module } from "@nestjs/common";
import {
  PrometheusModule,
  makeCounterProvider,
  makeGaugeProvider,
  makeHistogramProvider,
} from "@willsoto/nestjs-prometheus";

/**
 * Core metric set (plan § Observability). Metric names are part of the
 * public dashboard/alerting contract — treat renames as breaking. Identity
 * is deliberately NOT a label (cardinality).
 *
 * Inject with `@InjectMetric("v402_requests_total")` etc.
 */
const metricProviders = [
  makeCounterProvider({
    name: "v402_requests_total",
    help: "Payment-guarded requests by scheme and response status",
    labelNames: ["scheme", "status"],
  }),
  makeHistogramProvider({
    name: "v402_request_duration_seconds",
    help: "Duration of payment phases",
    labelNames: ["scheme", "phase"],
    buckets: [0.001, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5],
  }),
  makeHistogramProvider({
    name: "v402_verify_duration_seconds",
    help: "Signature verification duration by verifier mode",
    labelNames: ["mode"],
    buckets: [0.001, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1],
  }),
  makeCounterProvider({
    name: "v402_balance_debited_total",
    help: "Total debited satoshis (committed payments)",
  }),
  makeCounterProvider({
    name: "v402_deposits_credited_total",
    help: "Number of credited deposits",
  }),
  makeCounterProvider({
    name: "v402_late_commit_total",
    help: "Late commits after reaper refund (B3) — money booked late, never lost",
  }),
  makeGaugeProvider({
    name: "v402_watcher_lag_blocks",
    help: "Deposit watcher lag behind the chain tip",
  }),
  makeGaugeProvider({
    name: "v402_circuit_state",
    help: "Verus RPC circuit breaker state (0=closed, 1=half-open, 2=open)",
    labelNames: ["name"],
  }),
  makeCounterProvider({
    name: "v402_reconciliation_mismatch_total",
    help: "Balance/ledger mismatches found by reconciliation runs",
  }),
  makeGaugeProvider({
    name: "v402_reconciliation_last_ok_timestamp",
    help: "Unix seconds of the last clean reconciliation run",
  }),
];

@Module({
  imports: [
    PrometheusModule.register({
      path: "/metrics",
      defaultMetrics: { enabled: true },
    }),
  ],
  providers: metricProviders,
  exports: metricProviders,
})
export class MetricsModule {}
