/**
 * Result types for the daemon methods v402 uses. Deliberately open
 * (`[key: string]: unknown`) — the daemon returns far more fields than we
 * model, and new daemon versions may add fields at any time.
 */

export interface VerusInfo {
  VRSCversion: string;
  version: number;
  name: string;
  blocks: number;
  chainid: string;
  [key: string]: unknown;
}

export interface SignMessageResult {
  hash: string;
  signature: string;
  [key: string]: unknown;
}

export interface VerusBlock {
  hash: string;
  height: number;
  time: number;
  previousblockhash?: string;
  /** txids at verbosity 1. */
  tx: string[];
  [key: string]: unknown;
}

/** getblock verbosity 2 — full transaction objects inline. */
export interface VerusBlockVerbose {
  hash: string;
  height: number;
  time: number;
  previousblockhash?: string;
  tx: VerusRawTransaction[];
  [key: string]: unknown;
}

export interface VerusScriptPubKey {
  addresses?: string[];
  [key: string]: unknown;
}

export interface VerusVin {
  txid?: string;
  vout?: number;
  coinbase?: string;
  /** Present at verbosity 2 — needed for sender-VerusID deposit attribution. */
  address?: string;
  addresses?: string[];
  [key: string]: unknown;
}

export interface VerusVout {
  value: number;
  valueSat?: number;
  n: number;
  scriptPubKey: VerusScriptPubKey;
  [key: string]: unknown;
}

export interface VerusRawTransaction {
  txid: string;
  vin: VerusVin[];
  vout: VerusVout[];
  blockhash?: string;
  height?: number;
  confirmations?: number;
  [key: string]: unknown;
}

export interface VerusIdentityDefinition {
  name: string;
  identityaddress: string;
  parent: string;
  systemid: string;
  primaryaddresses: string[];
  minimumsignatures: number;
  revocationauthority: string;
  recoveryauthority: string;
  flags: number;
  version: number;
  timelock: number;
  [key: string]: unknown;
}

export interface VerusIdentityResult {
  identity: VerusIdentityDefinition;
  status: string;
  blockheight: number;
  fullyqualifiedname?: string;
  [key: string]: unknown;
}

export interface SendCurrencyOutput {
  address: string;
  amount: number | string;
  currency?: string;
  memo?: string;
  [key: string]: unknown;
}

/**
 * The RPC surface the v402 stack depends on. `VerusRpcClient` is the real
 * implementation; `MockVerusRpc` serves unit tests of dependent packages.
 */
export interface IVerusRpc {
  getInfo(): Promise<VerusInfo>;
  getBlockCount(): Promise<number>;
  getBlock(hashOrHeight: string | number): Promise<VerusBlock>;
  /** Verbosity 2 — full tx objects; the deposit watcher scans blocks this way. */
  getBlockVerbose(hashOrHeight: string | number): Promise<VerusBlockVerbose>;
  getRawTransaction(txid: string): Promise<VerusRawTransaction>;
  getIdentity(nameOrAddress: string): Promise<VerusIdentityResult>;
  signMessage(signer: string, message: string): Promise<SignMessageResult>;
  verifyMessage(signer: string, signature: string, message: string): Promise<boolean>;
  /** Returns the operation id (z_getoperationstatus tracks completion). */
  sendCurrency(fromAddress: string, outputs: SendCurrencyOutput[]): Promise<string>;
}

export interface VerusRpcCircuitConfig {
  /** Per-call timeout. Default 500ms. */
  timeoutMs: number;
  /** Consecutive unavailability failures before the circuit opens. Default 5. */
  failuresBeforeOpen: number;
  /** How long the circuit stays open before a half-open probe. Default 30s. */
  recoveryMs: number;
}

export interface VerusRpcConfig {
  rpcUrl: string;
  rpcUser: string;
  rpcPass: string;
  circuit?: Partial<VerusRpcCircuitConfig>;
  /** Injectable for tests. Defaults to global fetch. */
  fetchImpl?: typeof fetch;
}
