export { V402ProtocolError, type V402ProtocolErrorCode } from "./errors.js";
export {
  PROTOCOL_VERSION,
  SCHEME_VERUS_PREPAID_SIG,
  VERUS_PREPAID_SIG_VERSION,
  BALANCE_QUERY_CONTEXT,
  schemeContextLine,
} from "./version.js";
export { V402_HEADERS, REQUIRED_PAYMENT_HEADERS } from "./headers.js";
export type {
  ExtensionField,
  CanonicalPayload,
  BalanceQueryPayload,
  PaymentRequirement,
  Payment402Response,
  PaymentClaim,
  DiscoveryDocument,
} from "./types.js";
export { AMOUNT_DECIMALS, SATS_PER_COIN, isValidHumanAmount, humanToSats, satsToHuman } from "./amount.js";
export {
  MAX_EXTENSIONS_BYTES,
  isValidExtensionKey,
  serializeExtensionBlock,
  parseExtensionBlock,
} from "./extensions.js";
export { canonicalize, canonicalizeBalanceQuery, isValidUlid } from "./canonical.js";
export { isBase64Signature, assertBase64Signature } from "./signature.js";
export {
  humanAmountSchema,
  ulidSchema,
  identitySchema,
  unixSecondsSchema,
  paymentRequirementSchema,
  payment402ResponseSchema,
  discoveryDocumentSchema,
  parsePaymentHeaders,
  type ParsePaymentHeadersResult,
} from "./schemas.js";
