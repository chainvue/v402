/**
 * Public signer abstraction (plan § Client-Side Key Management): the client
 * library never touches raw keys — it hands the canonical string to a Signer
 * and gets back the standard-Base64 signature for X-V402-Signature.
 * Community implementations (LedgerSigner, KeychainSigner, …) plug in here.
 */
export interface Signer {
  /** Sign the canonical payload; returns the Base64 signature verusd verifymessage accepts. */
  signMessage(message: string): Promise<string>;
}

/**
 * Supplies a recent block height for locally constructed VerusID signatures
 * (the identity signature format embeds the signing height; verifiers resolve
 * the identity's primary keys at that height). The v402 client wires this to
 * the facilitator's public health endpoint; node-adjacent setups use
 * getblockcount.
 */
export type HeightProvider = () => Promise<number>;
