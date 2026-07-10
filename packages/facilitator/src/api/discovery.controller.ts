import { Controller, Get, Inject } from "@nestjs/common";
import { VERUS_PREPAID_SIG_VERSION } from "@chainvue/v402-protocol";
import { V402_CONFIG } from "../config/config.module.js";
import type { FacilitatorConfig } from "../config/schema.js";

/**
 * GET /.well-known/v402 — public, unauthenticated discovery (Q5, RFC 8615
 * convention). Same source of truth as the 402 responses: the config.
 * Trust model per spec: this document is unauthenticated — HTTPS required
 * in production, clients SHOULD pin payTo.
 */
@Controller(".well-known")
export class DiscoveryController {
  constructor(@Inject(V402_CONFIG) private readonly config: FacilitatorConfig) {}

  @Get("v402")
  discovery(): unknown {
    const schemes = this.config.schemes
      .filter((s) => s.enabled)
      .map((s) => ({
        scheme: s.name,
        schemeVersion: VERUS_PREPAID_SIG_VERSION,
        network: this.config.verus.chain,
        asset: s.config.asset,
        payTo: s.config.payToIdentity,
      }));
    return {
      specUrl: this.config.payment.specUrl,
      supportedVersions: this.config.payment.supportedVersions,
      defaultVersion: this.config.payment.defaultVersion,
      deprecatedVersions: [],
      sunsetDates: {},
      supportedExtensions: this.config.payment.supportedExtensions,
      defaultScheme: this.config.defaultScheme,
      schemes,
      topup: {
        depositAddress: schemes[0]?.payTo,
        attribution: "sender-verusid",
        instructionsEndpoint: "/v1/topup-instructions",
      },
    };
  }
}
