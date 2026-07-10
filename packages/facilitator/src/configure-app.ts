import type { INestApplication } from "@nestjs/common";
import type { FacilitatorConfig } from "./config/schema.js";

/**
 * HTTP-level app configuration shared by main.ts and the e2e tests.
 *
 * CORS is default-deny (plan § CORS Policy): with no allowed origins we
 * simply never emit CORS headers, so browsers block cross-origin use.
 * Opt-in via cors.allowedOrigins; no credentials (no cookies in v402).
 */
export function configureApp(app: INestApplication, config: FacilitatorConfig): void {
  if (config.cors.allowedOrigins.length > 0) {
    app.enableCors({
      origin: config.cors.allowedOrigins,
      credentials: false,
      allowedHeaders: [
        "Content-Type",
        "X-V402-Scheme",
        "X-V402-Payer",
        "X-V402-Amount",
        "X-V402-Request-Id",
        "X-V402-Issued-At",
        "X-V402-Signature",
        "X-V402-Extensions",
      ],
      exposedHeaders: ["X-V402-Balance", "X-V402-Request-Id"],
    });
  }
}
