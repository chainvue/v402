import { createHash } from "node:crypto";
import {
  MAX_EXTENSIONS_BYTES,
  SCHEME_VERUS_PREPAID_SIG,
  V402ProtocolError,
  VERUS_PREPAID_SIG_VERSION,
  canonicalize,
  humanToSats,
  isBase64Signature,
  normalizeIdentityKey,
  parseExtensionBlock,
  parsePaymentHeaders,
  type ExtensionField,
  type PaymentClaim,
} from "@chainvue/v402-protocol";
import type { IStorage } from "@chainvue/v402-storage";
import { verifyIdentitySignature } from "@chainvue/v402-signer-verus";
import { VerusRpcUnavailableError, type IVerusRpc } from "@chainvue/v402-verus-rpc";
import { CachedIdentityProvider, type IdentityStateProvider } from "./identity-provider.js";
import { parseSchemeHeader } from "./registry.js";
import type {
  CommitResult,
  IncomingPaymentRequest,
  RollbackResult,
  RoutePolicy,
  SchemeVerifier,
  VerifyAndReserveResult,
  VerifyResult,
  VerifyError,
  VerifyErrorCode,
} from "./types.js";

export interface PrepaidSigVerifierConfig {
  /** e.g. "vrsctest" — canonical core field (M3). */
  network: string;
  /** e.g. "VRSCTEST". */
  asset: string;
  /** Receiving identity, e.g. "explorerAPI@". */
  payTo: string;
  /** Domain the signature is bound to, e.g. "explorer.example.com". */
  canonicalDomain: string;
  /** ±window for issuedAt. Default 300s. */
  timestampToleranceSec?: number;
  /** Decoded X-V402-Extensions size limit (B2). Default 4096. */
  maxExtensionsBytes?: number;
  /** Enabled scheme versions. Default ["0.1"]. */
  schemeVersions?: string[];
  /**
   * `rpc` (default) verifies each signature via verifymessage
   * (checklatest=true). `offline` verifies by local pubkey recovery against
   * cached latest identity state — no RPC per request; revocation/rotation
   * take effect within the identity cache TTL instead of immediately.
   */
  verificationMode?: "rpc" | "offline";
  /** Offline mode: identity-state cache TTL. Default 60. */
  identityCacheTtlSec?: number;
}

export interface PrepaidSigVerifierDeps {
  storage: IStorage;
  rpc: IVerusRpc;
  config: PrepaidSigVerifierConfig;
  /** Offline mode: identity-state source. Default: CachedIdentityProvider over `rpc`. */
  identityProvider?: IdentityStateProvider;
  /** Unix-seconds clock, injectable for tests. */
  now?: () => number;
}

/** scheme.* extensions this verifier knows how to verify semantically. Unknown scheme.* → strict reject (B2). */
const KNOWN_SCHEME_EXTENSIONS = new Set(["scheme.bodyHash"]);
const BODY_HASH_RE = /^sha256:[0-9a-f]{64}$/;

function fail(httpStatus: number, code: VerifyErrorCode, message: string, details?: Record<string, unknown>): { ok: false; error: VerifyError } {
  const error: VerifyError = { httpStatus, code, message };
  if (details !== undefined) error.details = details;
  return { ok: false, error };
}

/**
 * The `verus-prepaid-sig` scheme (RPC verification mode, Q10). Order of
 * checks follows plan § PaymentGuard, cheapest first: headers → amount
 * pre-check (M6) → extensions (B2) → timestamp window → blocklist →
 * signature RPC → atomic reserve. The blocklist runs BEFORE the signature
 * RPC (plan lists it after): a blocked identity must not be able to burn
 * node capacity, and the check is a local DB lookup.
 */
export class VerusPrepaidSigVerifier implements SchemeVerifier {
  readonly scheme = SCHEME_VERUS_PREPAID_SIG;
  readonly schemeVersions: string[];

  private readonly storage: IStorage;
  private readonly rpc: IVerusRpc;
  private readonly config: Required<PrepaidSigVerifierConfig>;
  private readonly identityProvider: IdentityStateProvider | undefined;
  private readonly now: () => number;

  constructor(deps: PrepaidSigVerifierDeps) {
    this.storage = deps.storage;
    this.rpc = deps.rpc;
    this.config = {
      timestampToleranceSec: 300,
      maxExtensionsBytes: MAX_EXTENSIONS_BYTES,
      schemeVersions: [VERUS_PREPAID_SIG_VERSION],
      verificationMode: "rpc",
      identityCacheTtlSec: 60,
      ...deps.config,
    };
    this.schemeVersions = this.config.schemeVersions;
    this.identityProvider =
      this.config.verificationMode === "offline"
        ? (deps.identityProvider ?? new CachedIdentityProvider(deps.rpc, { ttlSec: this.config.identityCacheTtlSec }))
        : undefined;
    this.now = deps.now ?? (() => Math.floor(Date.now() / 1000));
  }

  /** Stateless verification: all checks incl. the signature RPC, no storage writes. */
  async verify(request: IncomingPaymentRequest, policy: RoutePolicy): Promise<VerifyResult> {
    const checked = await this.runChecks(request, policy);
    if (!checked.ok) return checked;
    return {
      ok: true,
      requestId: checked.claim.requestId,
      payer: checked.identityKey,
      amountSats: humanToSats(policy.priceHuman),
    };
  }

  async verifyAndReserve(request: IncomingPaymentRequest, policy: RoutePolicy): Promise<VerifyAndReserveResult> {
    // Replay short-circuit BEFORE the expensive checks: a requestId that is
    // already burned can only ever produce `replay`, so answer from the local
    // DB without spending a verifymessage RPC on it. Duplicate requests would
    // otherwise each cost a full RPC — an amplification lever for anyone
    // holding a captured (already-spent) signed request. reservePayment still
    // re-checks atomically, so this is purely an optimization, not the guard.
    const preParsed = parsePaymentHeaders(request.headers);
    if (preParsed.ok) {
      const existing = await this.storage.getSpentRequest(preParsed.claim.requestId);
      if (existing !== undefined) {
        return fail(409, "replay", "requestId already spent", { previousStatus: existing.status });
      }
    }

    const checked = await this.runChecks(request, policy);
    if (!checked.ok) return checked;
    const { claim, identityKey, receivedAt } = checked;

    const reserved = await this.storage.reservePayment({
      requestId: claim.requestId,
      identityId: identityKey,
      issuedAt: claim.issuedAt,
      receivedAt,
      amountSats: humanToSats(policy.priceHuman),
      method: request.method,
      path: request.path,
    });
    switch (reserved.status) {
      case "reserved":
        return {
          ok: true,
          requestId: claim.requestId,
          payer: identityKey,
          amountSats: humanToSats(policy.priceHuman),
          balanceAfterSats: reserved.balanceAfterSats,
        };
      case "replay":
        return fail(409, "replay", "requestId already spent", { previousStatus: reserved.previousStatus });
      case "insufficient":
        return fail(402, "insufficient-balance", "prepaid balance too low", {
          balanceSats: reserved.balanceSats.toString(),
          requiredSats: humanToSats(policy.priceHuman).toString(),
          depositAddress: this.config.payTo,
        });
      case "unknown-identity":
        return fail(402, "no-balance", "identity has no balance — deposit first", {
          depositAddress: this.config.payTo,
        });
    }
  }

  /** Shared check pipeline through signature verification (steps 1–7 of the guard order). */
  private async runChecks(
    request: IncomingPaymentRequest,
    policy: RoutePolicy,
  ): Promise<
    | { ok: true; claim: PaymentClaim; identityKey: string; receivedAt: number }
    | { ok: false; error: VerifyError }
  > {
    // 1. Headers
    const parsed = parsePaymentHeaders(request.headers);
    if (!parsed.ok) return fail(400, "invalid-headers", parsed.error);
    const claim = parsed.claim;

    // 2. Scheme + scheme version (M2)
    const schemeHeader = parseSchemeHeader(claim.scheme);
    if (schemeHeader.scheme !== this.scheme) {
      return fail(402, "unsupported-scheme", `unsupported scheme: ${schemeHeader.scheme}`, {
        supportedSchemes: [this.scheme],
      });
    }
    const schemeVersion = schemeHeader.version ?? this.schemeVersions[0]!;
    if (!this.schemeVersions.includes(schemeVersion)) {
      return fail(400, "unsupported-scheme-version", `unsupported scheme version: ${schemeVersion}`, {
        supportedSchemeVersions: this.schemeVersions,
      });
    }

    // 3. Amount pre-check (M6) — byte comparison, before any RPC
    if (claim.amount !== policy.priceHuman) {
      return fail(402, "price-mismatch", "signed amount does not match the current price", {
        currentPrice: policy.priceHuman,
      });
    }

    // 4. Extensions (B2)
    const extensionsResult = this.decodeExtensions(claim, request, policy);
    if ("error" in extensionsResult) return extensionsResult.error;
    const extensions = extensionsResult.fields;

    // 5. Timestamp window
    const nowSec = this.now();
    if (Math.abs(nowSec - claim.issuedAt) > this.config.timestampToleranceSec) {
      return fail(400, "timestamp-out-of-window", "issuedAt outside the accepted window", {
        toleranceSec: this.config.timestampToleranceSec,
      });
    }

    // 6. Blocklist — before the signature RPC (local lookup, saves node capacity).
    // Balance state is keyed by the normalized identity (chain resolves names
    // case-insensitively); the canonical payload keeps the payer as signed.
    const identityKey = normalizeIdentityKey(claim.payer);
    if (await this.storage.isBlocked(identityKey)) {
      return fail(403, "blocked", "identity is blocked");
    }

    // 7. Rebuild canonical payload from server truth + verbatim extensions, verify via RPC
    let canonical: string;
    try {
      canonical = canonicalize({
        scheme: this.scheme,
        schemeVersion,
        canonicalDomain: this.config.canonicalDomain,
        method: request.method,
        path: request.path,
        network: this.config.network,
        asset: this.config.asset,
        amount: policy.priceHuman,
        payer: claim.payer,
        payTo: this.config.payTo,
        requestId: claim.requestId,
        issuedAt: claim.issuedAt,
        extensions,
      });
    } catch (err) {
      if (err instanceof V402ProtocolError) {
        return fail(400, "invalid-request", `request not canonicalizable: ${err.message}`);
      }
      throw err;
    }

    let signatureValid: boolean;
    try {
      signatureValid =
        this.identityProvider !== undefined
          ? await this.verifySignatureOffline(this.identityProvider, claim.payer, claim.signature, canonical)
          : // checkLatest=true (decision with D2): identity signatures embed a
            // block height and verusd resolves the identity's keys AT that
            // height by default — a compromised-then-rotated key could keep
            // signing with an old height forever. Verifying against the LATEST
            // identity state makes revocation and key rotation take effect
            // immediately.
            await this.rpc.verifyMessage(claim.payer, claim.signature, canonical, true);
    } catch (err) {
      if (err instanceof VerusRpcUnavailableError) {
        // client MAY retry with the SAME requestId (M5) — nothing reserved yet
        return fail(503, "verify-unavailable", "signature verification temporarily unavailable", {
          retryAfterSec: 5,
        });
      }
      // daemon answered with an app error (e.g. unknown identity) — semantic reject
      signatureValid = false;
    }
    if (!signatureValid) return fail(402, "invalid-signature", "signature verification failed");

    return { ok: true, claim, identityKey, receivedAt: nowSec };
  }

  /**
   * Offline verification: pubkey recovery against cached latest identity
   * state. On failure, refresh the state once and re-verify — a key rotation
   * inside the cache TTL would otherwise reject freshly re-signed requests.
   * The provider rate-limits refreshes, so invalid-signature spam cannot be
   * turned into per-request RPC load.
   */
  private async verifySignatureOffline(
    provider: IdentityStateProvider,
    payer: string,
    signature: string,
    canonical: string,
  ): Promise<boolean> {
    const state = await provider.getIdentityState(payer);
    if (verifyIdentitySignature(canonical, signature, state.systemId, state).valid) return true;
    const fresh = await provider.refreshIdentityState(payer);
    if (fresh === state) return false; // refresh was rate-limited — same state, same verdict
    return verifyIdentitySignature(canonical, signature, fresh.systemId, fresh).valid;
  }

  private decodeExtensions(
    claim: PaymentClaim,
    request: IncomingPaymentRequest,
    policy: RoutePolicy,
  ): { fields: ExtensionField[] } | { error: { ok: false; error: VerifyError } } {
    let fields: ExtensionField[] = [];
    if (claim.extensionsRaw !== undefined) {
      if (!isBase64Signature(claim.extensionsRaw)) {
        return { error: fail(400, "invalid-extensions", "X-V402-Extensions is not valid base64") };
      }
      const decoded = Buffer.from(claim.extensionsRaw, "base64");
      if (decoded.byteLength > this.config.maxExtensionsBytes) {
        return {
          error: fail(400, "extensions-too-large", "decoded extension block exceeds the size limit", {
            maxBytes: this.config.maxExtensionsBytes,
          }),
        };
      }
      try {
        fields = parseExtensionBlock(decoded.toString("utf8"));
      } catch (err) {
        if (err instanceof V402ProtocolError) {
          return { error: fail(400, "invalid-extensions", err.message) };
        }
        throw err;
      }
      for (const field of fields) {
        if (field.key.startsWith("scheme.") && !KNOWN_SCHEME_EXTENSIONS.has(field.key)) {
          return { error: fail(400, "unknown-scheme-extension", `unknown scheme extension: ${field.key}`) };
        }
        if (field.key.startsWith("iana.")) {
          return { error: fail(400, "reserved-extension", `iana.* is reserved until registered: ${field.key}`) };
        }
        // x-<vendor>.* — accepted, semantically ignored, still part of the signed bytes
      }
    }

    const bodyHash = fields.find((f) => f.key === "scheme.bodyHash");
    if (policy.bodyHashPolicy !== "ignored") {
      const hasBody = request.rawBody !== undefined && request.rawBody.byteLength > 0;
      if (bodyHash === undefined && policy.bodyHashPolicy === "required" && hasBody) {
        return { error: fail(400, "body-hash-required", "this endpoint requires scheme.bodyHash for body-carrying requests") };
      }
      if (bodyHash !== undefined) {
        if (!BODY_HASH_RE.test(bodyHash.value)) {
          return { error: fail(400, "invalid-body-hash", "scheme.bodyHash must be sha256:<64 lowercase hex>") };
        }
        const actual = createHash("sha256")
          .update(request.rawBody ?? new Uint8Array(0))
          .digest("hex");
        if (bodyHash.value !== `sha256:${actual}`) {
          return { error: fail(400, "body-hash-mismatch", "request body does not match scheme.bodyHash") };
        }
      }
    }
    return { fields };
  }

  /** Phase 2 on success. Idempotent; resolves the reaper race via late commit (B3). */
  async commit(requestId: string, responseBytes: number): Promise<CommitResult> {
    const nowSec = this.now();
    const committed = await this.storage.commitPayment(requestId, responseBytes, nowSec);
    if (committed.ok) return { ok: true, alreadyCommitted: false, late: false };

    if (committed.currentStatus === undefined) {
      return fail(404, "unknown-request", `unknown requestId: ${requestId}`);
    }
    if (committed.currentStatus === "committed") {
      return { ok: true, alreadyCommitted: true, late: false }; // idempotent repeat
    }
    if (committed.currentStatus === "error") {
      // reaper refunded before the 2xx landed — re-debit deterministically
      const late = await this.storage.lateCommitPayment(requestId, responseBytes, nowSec);
      if (late.ok) return { ok: true, alreadyCommitted: false, late: true, balanceAfterSats: late.balanceAfterSats };
      return fail(409, "invalid-state", `cannot late-commit from status ${late.currentStatus ?? "unknown"}`);
    }
    return fail(409, "invalid-state", `cannot commit from status ${committed.currentStatus}`);
  }

  /** Phase 2 on error. Idempotent. RequestId stays burned within the replay window. */
  async rollback(requestId: string): Promise<RollbackResult> {
    const rolledBack = await this.storage.rollbackPayment(requestId, this.now());
    if (rolledBack.ok) return { ok: true, alreadyRolledBack: false };

    if (rolledBack.currentStatus === undefined) {
      return fail(404, "unknown-request", `unknown requestId: ${requestId}`);
    }
    if (rolledBack.currentStatus === "error") {
      return { ok: true, alreadyRolledBack: true }; // idempotent repeat
    }
    return fail(409, "invalid-state", `cannot rollback from status ${rolledBack.currentStatus}`);
  }
}
