import {
  BrokenCircuitError,
  CircuitState,
  ConsecutiveBreaker,
  TaskCancelledError,
  TimeoutStrategy,
  circuitBreaker,
  handleWhen,
  timeout,
  wrap,
} from "cockatiel";
import { TransportError, VerusRpcUnavailableError } from "./errors.js";
import { JsonRpcTransport } from "./json-rpc.js";
import type {
  IVerusRpc,
  SendCurrencyOutput,
  SignMessageResult,
  VerusBlock,
  VerusBlockVerbose,
  VerusIdentityResult,
  VerusInfo,
  VerusRawTransaction,
  VerusRpcCircuitConfig,
  VerusRpcConfig,
} from "./types.js";

const DEFAULT_CIRCUIT: VerusRpcCircuitConfig = {
  timeoutMs: 500,
  failuresBeforeOpen: 5,
  recoveryMs: 30_000,
};

/** Unavailability failures trip the breaker; JSON-RPC app errors pass through untouched. */
function isUnavailability(err: unknown): boolean {
  return err instanceof TransportError || err instanceof TaskCancelledError;
}

export class VerusRpcClient implements IVerusRpc {
  private readonly transport: JsonRpcTransport;
  private readonly policy: ReturnType<typeof wrap>;
  private readonly breaker: ReturnType<typeof circuitBreaker>;

  constructor(config: VerusRpcConfig) {
    const circuit = { ...DEFAULT_CIRCUIT, ...config.circuit };
    this.transport = new JsonRpcTransport(config.rpcUrl, config.rpcUser, config.rpcPass, config.fetchImpl);
    this.breaker = circuitBreaker(handleWhen(isUnavailability), {
      halfOpenAfter: circuit.recoveryMs,
      breaker: new ConsecutiveBreaker(circuit.failuresBeforeOpen),
    });
    this.policy = wrap(this.breaker, timeout(circuit.timeoutMs, TimeoutStrategy.Aggressive));
  }

  /** For observability (metric `v402_circuit_state`). */
  circuitState(): "closed" | "open" | "half-open" | "isolated" {
    switch (this.breaker.state) {
      case CircuitState.Closed:
        return "closed";
      case CircuitState.Open:
        return "open";
      case CircuitState.HalfOpen:
        return "half-open";
      default:
        return "isolated";
    }
  }

  private async call<T>(method: string, params: unknown[]): Promise<T> {
    try {
      return (await this.policy.execute(() => this.transport.request(method, params))) as T;
    } catch (err) {
      if (err instanceof BrokenCircuitError) {
        throw new VerusRpcUnavailableError("circuit-open", `${method}: circuit breaker is open`);
      }
      if (err instanceof TaskCancelledError) {
        throw new VerusRpcUnavailableError("timeout", `${method}: RPC timed out`);
      }
      if (err instanceof TransportError) {
        throw new VerusRpcUnavailableError(err.reason, err.message);
      }
      throw err; // VerusRpcError — daemon answered, propagate app error as-is
    }
  }

  getInfo(): Promise<VerusInfo> {
    return this.call("getinfo", []);
  }

  getBlockCount(): Promise<number> {
    return this.call("getblockcount", []);
  }

  /** Verbosity 1: header + txids. verusd expects heights as strings. */
  getBlock(hashOrHeight: string | number): Promise<VerusBlock> {
    return this.call("getblock", [String(hashOrHeight), 1]);
  }

  getBlockVerbose(hashOrHeight: string | number): Promise<VerusBlockVerbose> {
    return this.call("getblock", [String(hashOrHeight), 2]);
  }

  /** Verbose form — includes vin/vout needed for deposit attribution. */
  getRawTransaction(txid: string): Promise<VerusRawTransaction> {
    return this.call("getrawtransaction", [txid, 1]);
  }

  getIdentity(nameOrAddress: string): Promise<VerusIdentityResult> {
    return this.call("getidentity", [nameOrAddress]);
  }

  getCurrencyBalance(addressOrIdentity: string, minConf = 1): Promise<Record<string, number> | number> {
    return this.call("getcurrencybalance", [addressOrIdentity, minConf]);
  }

  signMessage(signer: string, message: string): Promise<SignMessageResult> {
    return this.call("signmessage", [signer, message]);
  }

  verifyMessage(signer: string, signature: string, message: string): Promise<boolean> {
    return this.call("verifymessage", [signer, signature, message]);
  }

  sendCurrency(fromAddress: string, outputs: SendCurrencyOutput[]): Promise<string> {
    return this.call("sendcurrency", [fromAddress, outputs]);
  }
}
