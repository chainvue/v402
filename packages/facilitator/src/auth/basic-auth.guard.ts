import { timingSafeEqual } from "node:crypto";
import { CanActivate, ExecutionContext, Inject, Injectable, UnauthorizedException } from "@nestjs/common";
import { V402_CONFIG } from "../config/config.module.js";
import type { FacilitatorConfig } from "../config/schema.js";

/**
 * HTTP-Basic guard for the middleware-facing facilitator API (plan
 * § Facilitator API — Authorization). MVP: one operator-provisioned token;
 * the Basic username identifies the middleware (logged upstream), the
 * password must match `facilitator.authToken`.
 *
 * Fail closed: with no token configured the HTTP API is unusable — set
 * FACILITATOR_AUTH_TOKEN to enable it (in-process deployments never hit this).
 */
@Injectable()
export class BasicAuthGuard implements CanActivate {
  constructor(@Inject(V402_CONFIG) private readonly config: FacilitatorConfig) {}

  canActivate(context: ExecutionContext): boolean {
    const expected = this.config.facilitator.authToken;
    if (expected === "") {
      throw new UnauthorizedException("facilitator HTTP API disabled — no FACILITATOR_AUTH_TOKEN configured");
    }
    const request = context.switchToHttp().getRequest<{ headers: Record<string, string | undefined> }>();
    const header = request.headers["authorization"];
    if (header === undefined || !header.startsWith("Basic ")) {
      throw new UnauthorizedException("missing Basic authorization");
    }
    const decoded = Buffer.from(header.slice("Basic ".length), "base64").toString("utf8");
    const separator = decoded.indexOf(":");
    const password = separator === -1 ? "" : decoded.slice(separator + 1);
    const passwordBuf = Buffer.from(password, "utf8");
    const expectedBuf = Buffer.from(expected, "utf8");
    if (passwordBuf.length !== expectedBuf.length || !timingSafeEqual(passwordBuf, expectedBuf)) {
      throw new UnauthorizedException("invalid token");
    }
    return true;
  }
}
