import { Controller, Get, Inject, RequestMethod } from "@nestjs/common";
import { PATH_METADATA, METHOD_METADATA } from "@nestjs/common/constants.js";
import { DiscoveryService, MetadataScanner, Reflector } from "@nestjs/core";
import { PROTOCOL_VERSION } from "@chainvue/v402-protocol";
import type { VerifierRegistry } from "@chainvue/v402-verifier";
import { V402_PAYMENT_METADATA } from "./payment.decorator.js";
import { V402_ADVERTISEMENT, V402_REGISTRY } from "./payment.guard.js";
import type { PaymentAdvertisement, RoutePaymentMetadata } from "./types.js";

/** One priced route in the discovery document's `endpoints` listing. */
export interface DiscoveredEndpoint {
  method: string;
  path: string;
  amount: string;
  amountUnit: "human";
  asset: string;
  bodyHashPolicy: RoutePaymentMetadata["bodyHashPolicy"];
}

/**
 * Serves `GET /.well-known/v402` for the guarded API itself: the same
 * document shape the facilitator advertises (versions, schemes, topup)
 * PLUS an `endpoints` rate card derived from the `@V402Payment` route
 * metadata — a single source of truth, so the advertised prices can never
 * drift from what the guard actually charges (the failure mode of a
 * hand-maintained rate card). Additive field; clients validate discovery
 * documents with a loose schema.
 *
 * Registered by V402Module.forRoot() unless `discovery: false`.
 */
@Controller(".well-known")
export class V402DiscoveryController {
  private endpoints: DiscoveredEndpoint[] | undefined;

  constructor(
    @Inject(V402_ADVERTISEMENT) private readonly advertisement: PaymentAdvertisement,
    @Inject(V402_REGISTRY) private readonly registry: VerifierRegistry,
    @Inject(DiscoveryService) private readonly discovery: DiscoveryService,
    @Inject(MetadataScanner) private readonly scanner: MetadataScanner,
    @Inject(Reflector) private readonly reflector: Reflector,
  ) {}

  @Get("v402")
  document(): Record<string, unknown> {
    const schemes = this.registry.supportedSchemes().map((scheme) => ({
      scheme,
      schemeVersion: this.registry.get(scheme)?.schemeVersions[0] ?? "0.1",
      network: this.advertisement.network,
      asset: this.advertisement.asset,
      payTo: this.advertisement.payTo,
    }));
    return {
      supportedVersions: [PROTOCOL_VERSION],
      defaultVersion: PROTOCOL_VERSION,
      deprecatedVersions: [],
      sunsetDates: {},
      supportedExtensions: ["scheme.bodyHash"],
      canonicalDomain: this.advertisement.canonicalDomain,
      network: this.advertisement.network,
      defaultScheme: schemes[0]?.scheme,
      schemes,
      facilitator: this.advertisement.facilitatorUrl,
      topup: {
        depositAddress: this.advertisement.payTo,
        attribution: "sender-verusid",
        instructionsEndpoint: `${this.advertisement.facilitatorUrl.replace(/\/$/, "")}/v1/topup-instructions`,
      },
      endpoints: (this.endpoints ??= this.collectEndpoints()),
    };
  }

  /**
   * Walk every controller and collect routes carrying @V402Payment
   * metadata. Route tables are static after boot — computed once, cached.
   */
  private collectEndpoints(): DiscoveredEndpoint[] {
    const endpoints: DiscoveredEndpoint[] = [];
    for (const wrapper of this.discovery.getControllers()) {
      const instance: unknown = wrapper.instance;
      const { metatype } = wrapper;
      if (instance === undefined || instance === null || metatype === undefined || metatype === null) continue;
      const controllerPath = (Reflect.getMetadata(PATH_METADATA, metatype) as string | undefined) ?? "";
      const prototype = Object.getPrototypeOf(instance) as Record<string, unknown>;
      for (const name of this.scanner.getAllMethodNames(prototype)) {
        const handler = prototype[name] as (...args: unknown[]) => unknown;
        const route = this.reflector.get<RoutePaymentMetadata | undefined>(V402_PAYMENT_METADATA, handler);
        if (route === undefined) continue;
        const methodPath = (Reflect.getMetadata(PATH_METADATA, handler) as string | undefined) ?? "/";
        const methodIndex = (Reflect.getMetadata(METHOD_METADATA, handler) as RequestMethod | undefined) ?? RequestMethod.GET;
        endpoints.push({
          method: RequestMethod[methodIndex] ?? "GET",
          path: joinRoutePaths(controllerPath, methodPath),
          amount: route.priceHuman,
          amountUnit: "human",
          asset: this.advertisement.asset,
          bodyHashPolicy: route.bodyHashPolicy,
        });
      }
    }
    return endpoints.sort((a, b) => (a.path === b.path ? a.method.localeCompare(b.method) : a.path.localeCompare(b.path)));
  }
}

function joinRoutePaths(controllerPath: string, methodPath: string): string {
  const segments = [controllerPath, methodPath]
    .map((segment) => segment.replace(/^\/+|\/+$/g, ""))
    .filter((segment) => segment !== "");
  return "/" + segments.join("/");
}
