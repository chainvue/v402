import type {
  IVerusRpc,
  SendCurrencyOutput,
  SignMessageResult,
  VerusBlock,
  VerusIdentityResult,
  VerusInfo,
  VerusRawTransaction,
} from "./types.js";

/**
 * Test double for unit tests of packages that depend on `IVerusRpc`
 * (verifier, deposit-watcher, facilitator). Stub only what the test needs;
 * unstubbed methods throw. All invocations are recorded in `calls`.
 */
export class MockVerusRpc implements IVerusRpc {
  readonly calls: Array<{ method: string; params: unknown[] }> = [];

  constructor(private readonly impl: Partial<IVerusRpc> = {}) {}

  private dispatch<T>(method: keyof IVerusRpc, params: unknown[], fn: (() => Promise<T>) | undefined): Promise<T> {
    this.calls.push({ method, params });
    if (!fn) return Promise.reject(new Error(`MockVerusRpc: ${method} not stubbed`));
    return fn();
  }

  getInfo(): Promise<VerusInfo> {
    return this.dispatch("getInfo", [], this.impl.getInfo && (() => this.impl.getInfo!()));
  }

  getBlockCount(): Promise<number> {
    return this.dispatch("getBlockCount", [], this.impl.getBlockCount && (() => this.impl.getBlockCount!()));
  }

  getBlock(hashOrHeight: string | number): Promise<VerusBlock> {
    return this.dispatch("getBlock", [hashOrHeight], this.impl.getBlock && (() => this.impl.getBlock!(hashOrHeight)));
  }

  getRawTransaction(txid: string): Promise<VerusRawTransaction> {
    return this.dispatch(
      "getRawTransaction",
      [txid],
      this.impl.getRawTransaction && (() => this.impl.getRawTransaction!(txid)),
    );
  }

  getIdentity(nameOrAddress: string): Promise<VerusIdentityResult> {
    return this.dispatch(
      "getIdentity",
      [nameOrAddress],
      this.impl.getIdentity && (() => this.impl.getIdentity!(nameOrAddress)),
    );
  }

  signMessage(signer: string, message: string): Promise<SignMessageResult> {
    return this.dispatch(
      "signMessage",
      [signer, message],
      this.impl.signMessage && (() => this.impl.signMessage!(signer, message)),
    );
  }

  verifyMessage(signer: string, signature: string, message: string): Promise<boolean> {
    return this.dispatch(
      "verifyMessage",
      [signer, signature, message],
      this.impl.verifyMessage && (() => this.impl.verifyMessage!(signer, signature, message)),
    );
  }

  sendCurrency(fromAddress: string, outputs: SendCurrencyOutput[]): Promise<string> {
    return this.dispatch(
      "sendCurrency",
      [fromAddress, outputs],
      this.impl.sendCurrency && (() => this.impl.sendCurrency!(fromAddress, outputs)),
    );
  }
}
