export { V402Module } from "./v402.module.js";
export { V402Payment, V402_PAYMENT_METADATA } from "./payment.decorator.js";
export { PaymentGuard, V402_REGISTRY, V402_ADVERTISEMENT } from "./payment.guard.js";
export { PaymentInterceptor } from "./payment.interceptor.js";
// moved to @chainvue/v402-verifier (framework-neutral home, shared with the proxy) — re-exported for compatibility
export { HttpFacilitatorVerifier, build402Body, type HttpFacilitatorVerifierOptions } from "@chainvue/v402-verifier";
export { V402DiscoveryController, type DiscoveredEndpoint } from "./discovery.controller.js";
export {
  V402_CONTEXT,
  type PaymentAdvertisement,
  type RoutePaymentMetadata,
  type V402RequestContext,
  type V402ModuleOptions,
  type V402InProcessOptions,
  type V402HttpOptions,
  type V402SharedOptions,
  type RequestWithV402,
} from "./types.js";
