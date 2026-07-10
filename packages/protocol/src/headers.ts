/** Canonical HTTP header names of the v402/0.1 wire format. */
export const V402_HEADERS = {
  scheme: "X-V402-Scheme",
  payer: "X-V402-Payer",
  amount: "X-V402-Amount",
  requestId: "X-V402-Request-Id",
  issuedAt: "X-V402-Issued-At",
  signature: "X-V402-Signature",
  extensions: "X-V402-Extensions",
} as const;

/** Headers a payment request MUST carry (`X-V402-Extensions` is optional). */
export const REQUIRED_PAYMENT_HEADERS: readonly string[] = [
  V402_HEADERS.scheme,
  V402_HEADERS.payer,
  V402_HEADERS.amount,
  V402_HEADERS.requestId,
  V402_HEADERS.issuedAt,
  V402_HEADERS.signature,
];
