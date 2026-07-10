import { PROTOCOL_VERSION, REQUIRED_PAYMENT_HEADERS } from "@chainvue/v402-protocol";
import type { VerifierRegistry, VerifyError } from "@chainvue/v402-verifier";
import type { PaymentAdvertisement, RoutePaymentMetadata } from "./types.js";

/**
 * Body of a 402 Payment Required response (spec § 402 response): the
 * multi-entry `accepts` array from day 1, one entry per registered scheme,
 * plus the error detail when the 402 is a rejection rather than a challenge.
 */
export function build402Body(
  advertisement: PaymentAdvertisement,
  registry: VerifierRegistry,
  route: RoutePaymentMetadata,
  error?: VerifyError,
): Record<string, unknown> {
  const accepts = registry.supportedSchemes().map((scheme) => ({
    scheme,
    schemeVersion: registry.get(scheme)?.schemeVersions[0] ?? "0.1",
    network: advertisement.network,
    asset: advertisement.asset,
    amount: route.priceHuman,
    amountUnit: "human",
    payTo: advertisement.payTo,
    facilitator: advertisement.facilitatorUrl,
    requiredHeaders: [...REQUIRED_PAYMENT_HEADERS],
    canonicalDomain: advertisement.canonicalDomain,
    topup: {
      depositAddress: advertisement.payTo,
      attribution: "sender-verusid",
    },
  }));
  return {
    version: PROTOCOL_VERSION,
    ...(error !== undefined ? { error: { code: error.code, message: error.message, ...(error.details ? { details: error.details } : {}) } } : {}),
    accepts,
  };
}
