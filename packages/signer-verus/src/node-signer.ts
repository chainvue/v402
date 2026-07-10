import { VerusRpcClient, type IVerusRpc, type VerusRpcConfig } from "@chainvue/v402-verus-rpc";
import type { Signer } from "./types.js";

export interface NodeSignerOptions {
  /** Identity or address the wallet signs as, e.g. "v402.demoAgent@". */
  signer: string;
  /** Connection to the wallet-holding daemon… */
  rpc?: Pick<VerusRpcConfig, "rpcUrl" | "rpcUser" | "rpcPass" | "circuit">;
  /** …or an existing client (tests, shared instances). */
  rpcClient?: IVerusRpc;
}

/**
 * Recommended default when a Verus daemon is available (plan § Client-Side
 * Key Management): delegates to `signmessage` — the private key never enters
 * this process, rotation is wallet-native, and identity signatures come out
 * in the daemon's own format.
 */
export class NodeSigner implements Signer {
  private readonly rpc: IVerusRpc;
  private readonly signer: string;

  constructor(options: NodeSignerOptions) {
    if (options.rpcClient !== undefined) {
      this.rpc = options.rpcClient;
    } else if (options.rpc !== undefined) {
      this.rpc = new VerusRpcClient(options.rpc);
    } else {
      throw new Error("NodeSigner needs either rpc connection options or an rpcClient");
    }
    this.signer = options.signer;
  }

  async signMessage(message: string): Promise<string> {
    // daemon returns { hash, signature } (verusd >= 1.2.x)
    const result = await this.rpc.signMessage(this.signer, message);
    return result.signature;
  }
}
