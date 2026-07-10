import { SetMetadata, type CustomDecorator } from "@nestjs/common";
import type { RoutePaymentMetadata } from "./types.js";

export const V402_PAYMENT_METADATA = "v402:payment";

/**
 * Marks a route as payment-required (plan § demo-server usage:
 * `@V402Payment('0.001')`). Routes without this decorator are free.
 * The price string is advertised in 402 responses and compared byte-wise
 * against X-V402-Amount (M6) — never reformat it.
 */
export function V402Payment(
  priceHuman: string,
  options: { bodyHash?: RoutePaymentMetadata["bodyHashPolicy"] } = {},
): CustomDecorator<string> {
  const metadata: RoutePaymentMetadata = {
    priceHuman,
    bodyHashPolicy: options.bodyHash ?? "optional",
  };
  return SetMetadata(V402_PAYMENT_METADATA, metadata);
}
