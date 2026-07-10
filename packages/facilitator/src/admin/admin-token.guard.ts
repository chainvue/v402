import { timingSafeEqual } from "node:crypto";
import { CanActivate, ExecutionContext, Inject, Injectable, UnauthorizedException } from "@nestjs/common";
import { V402_CONFIG } from "../config/config.module.js";
import type { FacilitatorConfig } from "../config/schema.js";

/**
 * Bearer-token guard for /admin/* (plan: admin endpoints require
 * admin-token auth). Fail closed: without V402_ADMIN_TOKEN configured the
 * admin API is unusable.
 */
@Injectable()
export class AdminTokenGuard implements CanActivate {
  constructor(@Inject(V402_CONFIG) private readonly config: FacilitatorConfig) {}

  canActivate(context: ExecutionContext): boolean {
    const expected = this.config.ops.adminToken;
    if (expected === "") {
      throw new UnauthorizedException("admin API disabled — no V402_ADMIN_TOKEN configured");
    }
    const request = context.switchToHttp().getRequest<{ headers: Record<string, string | undefined> }>();
    const header = request.headers["authorization"];
    if (header === undefined || !header.startsWith("Bearer ")) {
      throw new UnauthorizedException("missing Bearer authorization");
    }
    const provided = Buffer.from(header.slice("Bearer ".length), "utf8");
    const expectedBuf = Buffer.from(expected, "utf8");
    if (provided.length !== expectedBuf.length || !timingSafeEqual(provided, expectedBuf)) {
      throw new UnauthorizedException("invalid admin token");
    }
    return true;
  }
}
