import { paidFetch, resolveConfig, type PaymentFetchConfig } from "./handshake.js";

/**
 * The thin integration path (plan § Client Library Surface):
 *
 *   const paidFetch = wrapFetchWithPayment(fetch, { payer, signer });
 *   const res = await paidFetch("http://api.example.com/tx/abc");
 *
 * Non-402 responses pass through untouched; 402 challenges are paid
 * transparently. Fully parallel-safe — every request rolls its own ULID.
 */
export function wrapFetchWithPayment(fetchImpl: typeof fetch, config: PaymentFetchConfig): typeof fetch {
  const resolved = resolveConfig(config);
  const wrapped = (url: string | URL | Request, init?: RequestInit): Promise<Response> => {
    if (url instanceof Request) {
      // Request objects may carry one-shot bodies the handshake would need twice
      throw new TypeError("wrapFetchWithPayment: pass (url, init), not a Request object");
    }
    return paidFetch(fetchImpl, url, init, resolved);
  };
  return wrapped;
}
