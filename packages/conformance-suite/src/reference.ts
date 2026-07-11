import {
  canonicalize,
  canonicalizeBalanceQuery,
  discoveryDocumentSchema,
  humanToSats,
  parseExtensionBlock,
  parsePaymentHeaders,
  payment402ResponseSchema,
  paymentRequirementSchema,
  satsToHuman,
  serializeExtensionBlock,
  type BalanceQueryPayload,
  type CanonicalPayload,
  type ExtensionField,
} from "@chainvue/v402-protocol";
import {
  decodeWif,
  signAddressMessage,
  verifyAddressSignature,
  verifyIdentitySignature,
  verusMessageHash,
} from "@chainvue/v402-signer-verus";
import type { ConformanceTarget, PinnedIdentity, WireFormatType } from "./types.js";

/**
 * The reference implementation as a conformance target — the packages of
 * this repository wired to the target interface. Serves two purposes:
 * self-conformance in CI (the vectors and the implementation must agree),
 * and a template for adapting other implementations.
 */
export function referenceTarget(): ConformanceTarget {
  return {
    name: "@chainvue/v402 reference implementation",

    canonicalize(payload: Record<string, unknown>, payloadType: "payment" | "balanceQuery"): string {
      return payloadType === "balanceQuery"
        ? canonicalizeBalanceQuery(payload as unknown as BalanceQueryPayload)
        : canonicalize(payload as unknown as CanonicalPayload);
    },

    serializeExtensions(fields: ReadonlyArray<{ key: string; value: string }>): string {
      return serializeExtensionBlock(fields as ExtensionField[]);
    },

    parseExtensions(block: string): Array<{ key: string; value: string }> {
      return parseExtensionBlock(block);
    },

    humanToSats(human: string): string {
      return humanToSats(human).toString();
    },

    satsToHuman(sats: string): string {
      return satsToHuman(BigInt(sats));
    },

    validateWireFormat(type: WireFormatType, value: unknown): { valid: boolean; claim?: unknown } {
      switch (type) {
        case "payment402":
          return { valid: payment402ResponseSchema.safeParse(value).success };
        case "paymentRequirement":
          return { valid: paymentRequirementSchema.safeParse(value).success };
        case "discovery":
          return { valid: discoveryDocumentSchema.safeParse(value).success };
        case "paymentHeaders": {
          const result = parsePaymentHeaders(value as Record<string, string | string[] | undefined>);
          return result.ok ? { valid: true, claim: result.claim } : { valid: false };
        }
      }
    },

    messageHash(message: string): string {
      return Buffer.from(verusMessageHash(message)).toString("hex");
    },

    signMessage(message: string, wif: string): string {
      return signAddressMessage(message, decodeWif(wif));
    },

    verifyMessage(message: string, signature: string, signer: string, identity?: PinnedIdentity): boolean {
      if (signer.endsWith("@")) {
        if (identity === undefined) throw new Error(`no identity state for ${signer}`);
        return verifyIdentitySignature(message, signature, identity.systemId, {
          identityAddress: identity.identityAddress,
          primaryAddresses: identity.primaryAddresses,
          minimumSignatures: identity.minimumSignatures,
        }).valid;
      }
      return verifyAddressSignature(message, signature, signer);
    },
  };
}
