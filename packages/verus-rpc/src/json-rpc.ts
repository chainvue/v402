import { TransportError, VerusRpcError } from "./errors.js";

interface JsonRpcErrorShape {
  code: number;
  message: string;
}

/**
 * Minimal JSON-RPC 1.0 transport for verusd (Bitcoin-style: HTTP POST, Basic
 * auth). Note that verusd answers application errors with HTTP 500 *and* a
 * JSON-RPC error body — so the body is parsed first and only unparseable
 * responses count as transport failures.
 */
export class JsonRpcTransport {
  private readonly url: string;
  private readonly authorization: string;
  private readonly fetchImpl: typeof fetch;

  constructor(url: string, user: string, pass: string, fetchImpl: typeof fetch = fetch) {
    this.url = url;
    this.authorization = "Basic " + Buffer.from(`${user}:${pass}`).toString("base64");
    this.fetchImpl = fetchImpl;
  }

  async request(method: string, params: unknown[]): Promise<unknown> {
    let response: Response;
    try {
      response = await this.fetchImpl(this.url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: this.authorization,
        },
        body: JSON.stringify({ jsonrpc: "1.0", id: "v402", method, params }),
      });
    } catch (err) {
      throw new TransportError("network", `${method}: ${err instanceof Error ? err.message : String(err)}`);
    }

    const text = await response.text();
    let body: { result?: unknown; error?: JsonRpcErrorShape | null };
    try {
      body = JSON.parse(text) as typeof body;
    } catch {
      throw new TransportError("bad-response", `${method}: HTTP ${response.status}, non-JSON body`);
    }
    if (body.error !== undefined && body.error !== null) {
      throw new VerusRpcError(method, body.error.code, body.error.message);
    }
    return body.result;
  }
}
