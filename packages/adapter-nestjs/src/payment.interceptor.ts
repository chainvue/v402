import { CallHandler, ExecutionContext, HttpException, Injectable, NestInterceptor } from "@nestjs/common";
import { catchError, from, mergeMap, throwError, type Observable } from "rxjs";
import { satsToHuman } from "@chainvue/v402-protocol";
import { V402_CONTEXT, type RequestWithV402 } from "./types.js";

interface ResponseLike {
  setHeader?: (name: string, value: string) => void;
}

/**
 * Phase 2 of the two-phase debit (plan § Payment Flow):
 * - handler succeeds → commit (idempotent; late commits handled downstream)
 * - handler throws 5xx → rollback (refund; requestId stays burned)
 * - handler throws 4xx → commit: the service answered definitively, the
 *   client's bad luck is not a refund reason (Stripe semantics)
 * Response headers X-V402-Request-Id (echo) and X-V402-Balance (post-request
 * balance) are set on success.
 */
@Injectable()
export class PaymentInterceptor implements NestInterceptor {
  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const request = context.switchToHttp().getRequest<RequestWithV402>();
    const v402 = request[V402_CONTEXT];
    if (v402 === undefined) return next.handle(); // free route

    const response = context.switchToHttp().getResponse<ResponseLike>();
    return next.handle().pipe(
      mergeMap((data: unknown) =>
        from(
          (async () => {
            const responseBytes = estimateBytes(data);
            await v402.verifier.commit(v402.requestId, responseBytes);
            response.setHeader?.("X-V402-Request-Id", v402.requestId);
            response.setHeader?.("X-V402-Balance", satsToHuman(v402.balanceAfterSats));
            return data;
          })(),
        ),
      ),
      catchError((err: unknown) => {
        const status = err instanceof HttpException ? err.getStatus() : 500;
        const settle = status >= 500 ? v402.verifier.rollback(v402.requestId) : v402.verifier.commit(v402.requestId, 0);
        return from(settle).pipe(mergeMap(() => throwError(() => err)));
      }),
    );
  }
}

function estimateBytes(data: unknown): number {
  if (data === undefined || data === null) return 0;
  if (typeof data === "string") return Buffer.byteLength(data);
  if (data instanceof Uint8Array) return data.byteLength;
  try {
    return Buffer.byteLength(JSON.stringify(data));
  } catch {
    return 0;
  }
}
