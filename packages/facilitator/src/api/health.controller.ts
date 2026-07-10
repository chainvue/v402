import { Controller, Get, HttpException, Inject } from "@nestjs/common";
import type { IWatcher } from "@chainvue/v402-deposit-watcher";
import type { IVerusRpc } from "@chainvue/v402-verus-rpc";
import { V402_CONFIG } from "../config/config.module.js";
import type { FacilitatorConfig } from "../config/schema.js";
import { VERUS_RPC, WATCHER } from "../core/core.module.js";

/**
 * GET /v1/health — public liveness/readiness: Verus RPC reachability +
 * deposit-watcher status (plan step 14). 200 when healthy, 503 when
 * degraded so load balancers and compose healthchecks can act on it.
 */
@Controller("v1/health")
export class HealthController {
  constructor(
    @Inject(V402_CONFIG) private readonly config: FacilitatorConfig,
    @Inject(VERUS_RPC) private readonly rpc: IVerusRpc,
    @Inject(WATCHER) private readonly watcher: IWatcher,
  ) {}

  @Get()
  async health(): Promise<unknown> {
    let verusRpc: Record<string, unknown>;
    let healthy = true;
    try {
      const info = await this.rpc.getInfo();
      verusRpc = { reachable: true, chain: info.name, blocks: info.blocks };
    } catch {
      verusRpc = { reachable: false };
      // a simulated-watcher deployment works without a node by design
      if (this.config.watcher.mode === "real") healthy = false;
    }

    const watcher = this.watcher.status();
    if (watcher.lastError !== undefined) healthy = false;

    const body = {
      status: healthy ? "ok" : "degraded",
      verusRpc,
      watcher,
    };
    if (!healthy) throw new HttpException(body, 503);
    return body;
  }
}
