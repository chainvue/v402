import { normalizeIdentityKey } from "@chainvue/v402-protocol";
import type { IdentityState } from "@chainvue/v402-signer-verus";
import type { IVerusRpc } from "@chainvue/v402-verus-rpc";

/** Identity state plus the chain i-address the identity digest binds. */
export type ResolvedIdentityState = IdentityState & { systemId: string };

/**
 * Source of latest identity state for offline signature verification —
 * the checklatest decision (D2) materialized as a data dependency: whatever
 * state this provider returns is what signatures are verified against.
 */
export interface IdentityStateProvider {
  getIdentityState(identity: string): Promise<ResolvedIdentityState>;
  /**
   * Refetch bypassing the TTL — the self-healing path after a failed
   * verification (the cached keys may have just rotated). Implementations
   * MUST rate-limit this (a signature-spam attacker must not be able to
   * turn every invalid request into an RPC call).
   */
  refreshIdentityState(identity: string): Promise<ResolvedIdentityState>;
}

export interface CachedIdentityProviderOptions {
  /**
   * How long a fetched identity state is served from cache. Bounds how long
   * a revocation/key rotation can go unnoticed in offline mode. Default 60.
   */
  ttlSec?: number;
  /** Minimum age before refreshIdentityState actually refetches. Default 5. */
  minRefreshAgeSec?: number;
  /** Cache entry cap (FIFO eviction) — bounds memory under payer churn. Default 10000. */
  maxEntries?: number;
  /** Unix-seconds clock, injectable for tests. */
  now?: () => number;
}

interface CacheEntry {
  state: ResolvedIdentityState;
  fetchedAt: number;
}

/**
 * TTL cache over `getidentity`. Concurrent lookups for the same identity
 * share one in-flight RPC; failed fetches are never cached (the next lookup
 * retries). No negative caching: an unknown identity hits the RPC each time,
 * which matches RPC-mode cost — and the blocklist runs before signature
 * verification anyway.
 */
export class CachedIdentityProvider implements IdentityStateProvider {
  private readonly rpc: IVerusRpc;
  private readonly ttlSec: number;
  private readonly minRefreshAgeSec: number;
  private readonly maxEntries: number;
  private readonly now: () => number;
  private readonly cache = new Map<string, CacheEntry>();
  private readonly inflight = new Map<string, Promise<ResolvedIdentityState>>();

  constructor(rpc: IVerusRpc, options: CachedIdentityProviderOptions = {}) {
    this.rpc = rpc;
    this.ttlSec = options.ttlSec ?? 60;
    this.minRefreshAgeSec = options.minRefreshAgeSec ?? 5;
    this.maxEntries = options.maxEntries ?? 10_000;
    this.now = options.now ?? (() => Math.floor(Date.now() / 1000));
  }

  async getIdentityState(identity: string): Promise<ResolvedIdentityState> {
    const key = normalizeIdentityKey(identity);
    const entry = this.cache.get(key);
    if (entry !== undefined && this.now() - entry.fetchedAt < this.ttlSec) return entry.state;
    return this.fetch(key, identity);
  }

  async refreshIdentityState(identity: string): Promise<ResolvedIdentityState> {
    const key = normalizeIdentityKey(identity);
    const entry = this.cache.get(key);
    if (entry !== undefined && this.now() - entry.fetchedAt < this.minRefreshAgeSec) return entry.state;
    return this.fetch(key, identity);
  }

  private fetch(key: string, identity: string): Promise<ResolvedIdentityState> {
    const running = this.inflight.get(key);
    if (running !== undefined) return running;
    const promise = this.rpc
      .getIdentity(identity)
      .then((result) => {
        const state: ResolvedIdentityState = {
          identityAddress: result.identity.identityaddress,
          primaryAddresses: result.identity.primaryaddresses,
          minimumSignatures: result.identity.minimumsignatures,
          revoked: result.status === "revoked",
          systemId: result.identity.systemid,
        };
        this.cache.delete(key); // reinsert = move to the back of the FIFO
        if (this.cache.size >= this.maxEntries) {
          const oldest = this.cache.keys().next().value;
          if (oldest !== undefined) this.cache.delete(oldest);
        }
        this.cache.set(key, { state, fetchedAt: this.now() });
        return state;
      })
      .finally(() => {
        this.inflight.delete(key);
      });
    this.inflight.set(key, promise);
    return promise;
  }
}
