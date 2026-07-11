import {
  CanActivate,
  ExecutionContext,
  HttpException,
  Inject,
  Injectable,
  InternalServerErrorException,
} from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import { build402Body, parseSchemeHeader, type IncomingPaymentRequest, type VerifierRegistry } from "@chainvue/v402-verifier";
import { V402_PAYMENT_METADATA } from "./payment.decorator.js";
import {
  V402_CONTEXT,
  type PaymentAdvertisement,
  type RequestWithV402,
  type RoutePaymentMetadata,
} from "./types.js";

export const V402_REGISTRY = Symbol("V402_REGISTRY");
export const V402_ADVERTISEMENT = Symbol("V402_ADVERTISEMENT");

/**
 * Phase 1 of the two-phase debit (plan § Payment Flow). Routes opt in via
 * @V402Payment; everything else passes through untouched. Dispatches by
 * X-V402-Scheme to the registered verifier; missing/unknown scheme → 402
 * challenge with the full `accepts` array.
 */
@Injectable()
export class PaymentGuard implements CanActivate {
  constructor(
    @Inject(Reflector) private readonly reflector: Reflector,
    @Inject(V402_REGISTRY) private readonly registry: VerifierRegistry,
    @Inject(V402_ADVERTISEMENT) private readonly advertisement: PaymentAdvertisement,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const route = this.reflector.getAllAndOverride<RoutePaymentMetadata | undefined>(V402_PAYMENT_METADATA, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (route === undefined) return true; // free route

    const request = context.switchToHttp().getRequest<RequestWithV402>();
    const schemeHeader = request.headers["x-v402-scheme"];
    const schemeValue = Array.isArray(schemeHeader) ? schemeHeader[0] : schemeHeader;
    if (schemeValue === undefined) {
      // the 402 challenge: no payment attempt yet, advertise how to pay
      throw new HttpException(build402Body(this.advertisement, this.registry, route), 402);
    }
    const verifier = this.registry.get(parseSchemeHeader(schemeValue).scheme);
    if (verifier === undefined) {
      throw new HttpException(
        build402Body(this.advertisement, this.registry, route, {
          httpStatus: 402,
          code: "unsupported-scheme",
          message: `unsupported scheme: ${schemeValue}`,
        }),
        402,
      );
    }

    // M1: request-target verbatim — Express originalUrl is the unrewritten wire value
    const path = request.originalUrl ?? request.url ?? "/";
    const contentLength = Number(request.headers["content-length"] ?? 0);
    if (route.bodyHashPolicy !== "ignored" && contentLength > 0 && request.rawBody === undefined) {
      // fail closed: without raw bytes a required/optional bodyHash cannot be verified
      throw new InternalServerErrorException(
        "v402: rawBody unavailable — create the Nest app with { rawBody: true } to use bodyHash policies",
      );
    }
    const incoming: IncomingPaymentRequest = {
      method: request.method,
      path,
      headers: request.headers,
      ...(request.rawBody !== undefined ? { rawBody: request.rawBody } : {}),
    };

    const result = await verifier.verifyAndReserve(incoming, {
      priceHuman: route.priceHuman,
      bodyHashPolicy: route.bodyHashPolicy,
    });
    if (!result.ok) {
      const body =
        result.error.httpStatus === 402
          ? build402Body(this.advertisement, this.registry, route, result.error)
          : { ok: false, error: result.error };
      throw new HttpException(body, result.error.httpStatus);
    }

    request[V402_CONTEXT] = {
      requestId: result.requestId,
      payer: result.payer,
      amountSats: result.amountSats,
      balanceAfterSats: result.balanceAfterSats,
      scheme: verifier.scheme,
      verifier,
    };
    return true;
  }
}
