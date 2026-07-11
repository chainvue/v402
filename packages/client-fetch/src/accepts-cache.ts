import type { PaymentRequirement } from "@chainvue/v402-protocol";

export interface AcceptsCacheOptions {
  /**
   * How long a cached requirement is used before the next request preflights
   * again. Staleness is safe either way — any 402 on a cached attempt
   * triggers a fresh handshake — the TTL only bounds how long a silently
   * changed advertisement keeps costing one extra roundtrip. Default 300.
   */
  ttlSec?: number;
  /** Entry cap, FIFO eviction — bounds memory under endpoint churn. Default 1000. */
  maxEntries?: number;
  /** Unix-seconds clock, injectable for tests. */
  now?: () => number;
}

interface CacheEntry {
  requirement: PaymentRequirement;
  storedAt: number;
}

/**
 * Per-endpoint cache of the 402 challenge's payment requirement — skips the
 * unpaid preflight roundtrip on repeat calls (the deliberate Etappe-1
 * simplicity, now optimized). Keyed by `METHOD origin/pathname`; query
 * strings deliberately excluded (prices are per route, the signed path still
 * carries the full request-target).
 */
export class AcceptsCache {
  private readonly ttlSec: number;
  private readonly maxEntries: number;
  private readonly now: () => number;
  private readonly entries = new Map<string, CacheEntry>();

  constructor(options: AcceptsCacheOptions = {}) {
    this.ttlSec = options.ttlSec ?? 300;
    this.maxEntries = options.maxEntries ?? 1000;
    this.now = options.now ?? (() => Math.floor(Date.now() / 1000));
  }

  static keyFor(method: string, target: URL): string {
    return `${method.toUpperCase()} ${target.origin}${target.pathname}`;
  }

  get(key: string): PaymentRequirement | undefined {
    const entry = this.entries.get(key);
    if (entry === undefined) return undefined;
    if (this.now() - entry.storedAt >= this.ttlSec) {
      this.entries.delete(key);
      return undefined;
    }
    return entry.requirement;
  }

  set(key: string, requirement: PaymentRequirement): void {
    this.entries.delete(key); // reinsert = move to the back of the FIFO
    if (this.entries.size >= this.maxEntries) {
      const oldest = this.entries.keys().next().value;
      if (oldest !== undefined) this.entries.delete(oldest);
    }
    this.entries.set(key, { requirement, storedAt: this.now() });
  }

  delete(key: string): void {
    this.entries.delete(key);
  }
}
