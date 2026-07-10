import { BadRequestException, Controller, Get, Inject, Query } from "@nestjs/common";
import { toDataURL } from "qrcode";
import { identitySchema, isValidHumanAmount } from "@chainvue/v402-protocol";
import { V402_CONFIG } from "../config/config.module.js";
import type { FacilitatorConfig } from "../config/schema.js";

/**
 * GET /v1/topup-instructions?identity=…&amount=… — public, no auth (plan
 * § Topup Instructions Endpoint): reveals nothing sensitive, just a URI
 * template + QR for the deposit flow. `amount` is optional.
 */
@Controller("v1/topup-instructions")
export class TopupController {
  constructor(@Inject(V402_CONFIG) private readonly config: FacilitatorConfig) {}

  @Get()
  async instructions(@Query("identity") identity?: string, @Query("amount") amount?: string): Promise<unknown> {
    if (identity === undefined || !identitySchema.safeParse(identity).success) {
      throw new BadRequestException({
        ok: false,
        error: { code: "invalid-identity", message: "identity query param must be a VerusID friendly name ending in '@'" },
      });
    }
    if (amount !== undefined && !isValidHumanAmount(amount)) {
      throw new BadRequestException({
        ok: false,
        error: { code: "invalid-amount", message: "amount must be a human decimal amount string" },
      });
    }

    const scheme = this.config.schemes.find((s) => s.enabled)!;
    const payTo = scheme.config.payToIdentity;
    const asset = scheme.config.asset;
    const params = new URLSearchParams({ to: payTo, currency: asset });
    if (amount !== undefined) params.set("amount", amount);
    params.set("from", identity);
    const paymentUri = `verus://send?${params.toString()}`;

    const amountText = amount !== undefined ? `${amount} ${asset}` : asset;
    return {
      instructions: {
        text: `Send ${amountText} from ${identity} to ${payTo}`,
        paymentUri,
        qrCode: await toDataURL(paymentUri),
      },
      network: this.config.verus.chain,
      asset,
      expectedConfirmations: this.config.watcher.minConfirmations,
      // Verus block time ~60s
      estimatedTimeMinutes: this.config.watcher.minConfirmations,
      pollBalanceEndpoint: `/v1/balance?identity=${encodeURIComponent(identity)}`,
    };
  }
}
