import { Controller, Get, HttpException, Inject, Param, UseGuards } from "@nestjs/common";
import { normalizeIdentityKey } from "@chainvue/v402-protocol";
import type { IStorage } from "@chainvue/v402-storage";
import { VerusRpcError, VerusRpcUnavailableError, type IVerusRpc } from "@chainvue/v402-verus-rpc";
import { BasicAuthGuard } from "../auth/basic-auth.guard.js";
import { STORAGE, VERUS_RPC } from "../core/core.module.js";

/**
 * GET /v1/identity/:id — on-chain identity lookup (primaries, minimum
 * signatures, revocation status) for the offline verifier's cache refresh
 * (Etappe 1.5), plus this facilitator's balance view when the identity has
 * an account here. Middleware-token protected.
 */
@Controller("v1/identity")
@UseGuards(BasicAuthGuard)
export class IdentityController {
  constructor(
    @Inject(VERUS_RPC) private readonly rpc: IVerusRpc,
    @Inject(STORAGE) private readonly storage: IStorage,
  ) {}

  @Get(":id")
  async getIdentity(@Param("id") id: string): Promise<unknown> {
    let result;
    try {
      result = await this.rpc.getIdentity(id);
    } catch (err) {
      if (err instanceof VerusRpcError) {
        throw new HttpException({ ok: false, error: { code: "unknown-identity", message: err.message } }, 404);
      }
      if (err instanceof VerusRpcUnavailableError) {
        throw new HttpException(
          { ok: false, error: { code: "verify-unavailable", message: "Verus RPC unavailable" } },
          503,
        );
      }
      throw err;
    }

    const identityKey = normalizeIdentityKey(
      result.fullyqualifiedname !== undefined ? result.fullyqualifiedname : `${result.identity.name}@`,
    );
    const account = await this.storage.getIdentity(identityKey);
    return {
      ok: true,
      identity: result.identity,
      status: result.status,
      blockheight: result.blockheight,
      ...(result.fullyqualifiedname !== undefined ? { fullyqualifiedname: result.fullyqualifiedname } : {}),
      account:
        account === undefined
          ? null
          : {
              identityId: account.identityId,
              balanceSats: account.balanceSats.toString(),
              createdAt: account.createdAt,
              ...(account.firstDepositAt !== undefined ? { firstDepositAt: account.firstDepositAt } : {}),
              ...(account.lastRequestAt !== undefined ? { lastRequestAt: account.lastRequestAt } : {}),
            },
    };
  }
}
