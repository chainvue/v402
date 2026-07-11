/**
 * Subprocess transport: drive a NON-JS v402 implementation through the
 * conformance vectors over a line-delimited JSON protocol (NDJSON) on
 * stdin/stdout. The child implements the same operations as
 * `ConformanceTarget`; anything it does not declare is skipped by the
 * runner — partial implementations report skips, never failures.
 *
 * Wire protocol (one JSON document per line):
 *
 *   runner → child   {"id": 1, "op": "hello"}
 *   child  → runner  {"id": 1, "ok": true, "result": {"name": "my-impl", "ops": ["canonicalize", …]}}
 *
 *   runner → child   {"id": 2, "op": "canonicalize", "args": {"payload": {…}, "payloadType": "payment"}}
 *   child  → runner  {"id": 2, "ok": true, "result": "verus-prepaid-sig/0.1\n…"}
 *
 *   error            {"id": 3, "ok": false, "error": {"code": "invalid-amount", "message": "…"}}
 *
 * Operations and their `args`/`result` shapes mirror `ConformanceTarget`
 * one-to-one (args is an object keyed by parameter name):
 *
 *   canonicalize        {payload, payloadType}           → string
 *   serializeExtensions {fields}                         → string
 *   parseExtensions     {block}                          → [{key, value}]
 *   humanToSats         {human}                          → string
 *   satsToHuman         {sats}                           → string
 *   validateWireFormat  {type, value}                    → {valid, claim?}
 *   messageHash         {message}                        → hex string
 *   signMessage         {message, wif}                   → base64 string
 *   verifyMessage       {message, signature, signer, identity?} → boolean
 *
 * Where a vector expects an error, the child MUST answer `ok: false` with
 * `error.code` equal to the vector's error identifier — the codes are
 * normative. The child's stdout is reserved for protocol lines; logs belong
 * on stderr.
 */
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import type { ConformanceTarget } from "./types.js";

/** Operation names a child may declare in its hello response. */
export const SUBPROCESS_OPS = [
  "canonicalize",
  "serializeExtensions",
  "parseExtensions",
  "humanToSats",
  "satsToHuman",
  "validateWireFormat",
  "messageHash",
  "signMessage",
  "verifyMessage",
] as const;
export type SubprocessOp = (typeof SUBPROCESS_OPS)[number];

export interface SubprocessTargetOptions {
  /** Executable to spawn (resolved via PATH). */
  command: string;
  args?: string[];
  /** Per-operation timeout. Default 10 s. */
  timeoutMs?: number;
}

export interface SubprocessTarget {
  target: ConformanceTarget;
  /** Ops the child declared in its hello response. */
  declaredOps: string[];
  /** End the child's stdin and wait for it to exit (SIGKILL after timeout). */
  close: () => Promise<void>;
}

interface WireResponse {
  id: number;
  ok: boolean;
  result?: unknown;
  error?: { code?: string; message?: string };
}

class WireError extends Error {
  readonly code: string | undefined;
  constructor(message: string, code?: string) {
    super(message);
    this.name = "WireError";
    this.code = code;
  }
}

/**
 * Spawn `command` and return a `ConformanceTarget` that forwards every
 * operation over the NDJSON protocol. Only ops the child declares in its
 * hello response are exposed — the runner skips the rest.
 */
export async function subprocessTarget(options: SubprocessTargetOptions): Promise<SubprocessTarget> {
  const timeoutMs = options.timeoutMs ?? 10_000;
  const child = spawn(options.command, options.args ?? [], { stdio: ["pipe", "pipe", "inherit"] });
  const pending = new Map<number, { resolve: (value: unknown) => void; reject: (err: Error) => void }>();
  let nextId = 1;
  let exited = false;

  const failAllPending = (reason: string): void => {
    for (const [, waiter] of pending) waiter.reject(new WireError(reason));
    pending.clear();
  };

  child.on("error", (err) => {
    exited = true;
    failAllPending(`failed to spawn ${options.command}: ${err.message}`);
  });
  child.on("exit", (code, signal) => {
    exited = true;
    failAllPending(`child exited (code ${code ?? "null"}, signal ${signal ?? "none"}) with requests in flight`);
  });

  const lines = createInterface({ input: child.stdout });
  lines.on("line", (line) => {
    if (line.trim() === "") return;
    let response: WireResponse;
    try {
      response = JSON.parse(line) as WireResponse;
    } catch {
      failAllPending(`child wrote a non-JSON line to stdout: ${line.slice(0, 200)}`);
      return;
    }
    const waiter = pending.get(response.id);
    if (waiter === undefined) return; // late reply after timeout — drop
    pending.delete(response.id);
    if (response.ok) waiter.resolve(response.result);
    else waiter.reject(new WireError(response.error?.message ?? "operation failed", response.error?.code));
  });

  const request = (op: string, args?: Record<string, unknown>): Promise<unknown> => {
    if (exited) return Promise.reject(new WireError("child process is not running"));
    const id = nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new WireError(`operation ${op} timed out after ${timeoutMs} ms`));
      }, timeoutMs);
      pending.set(id, {
        resolve: (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        reject: (err) => {
          clearTimeout(timer);
          reject(err);
        },
      });
      child.stdin.write(JSON.stringify(args === undefined ? { id, op } : { id, op, args }) + "\n");
    });
  };

  const hello = (await request("hello")) as { name?: unknown; ops?: unknown };
  if (typeof hello?.name !== "string" || !Array.isArray(hello.ops)) {
    child.kill("SIGKILL");
    throw new WireError('hello response must be {"name": string, "ops": string[]}');
  }
  const declaredOps = hello.ops.filter((op): op is string => typeof op === "string");
  const has = (op: SubprocessOp): boolean => declaredOps.includes(op);

  // Only declared ops become target methods — undefined ops make the runner
  // report the category as skipped, matching in-process partial targets.
  const target: ConformanceTarget = {
    name: hello.name,
    ...(has("canonicalize") && {
      canonicalize: async (payload: Record<string, unknown>, payloadType: "payment" | "balanceQuery") =>
        (await request("canonicalize", { payload, payloadType })) as string,
    }),
    ...(has("serializeExtensions") && {
      serializeExtensions: async (fields: ReadonlyArray<{ key: string; value: string }>) =>
        (await request("serializeExtensions", { fields })) as string,
    }),
    ...(has("parseExtensions") && {
      parseExtensions: async (block: string) =>
        (await request("parseExtensions", { block })) as Array<{ key: string; value: string }>,
    }),
    ...(has("humanToSats") && {
      humanToSats: async (human: string) => (await request("humanToSats", { human })) as string,
    }),
    ...(has("satsToHuman") && {
      satsToHuman: async (sats: string) => (await request("satsToHuman", { sats })) as string,
    }),
    ...(has("validateWireFormat") && {
      validateWireFormat: async (type: string, value: unknown) =>
        (await request("validateWireFormat", { type, value })) as { valid: boolean; claim?: unknown },
    }),
    ...(has("messageHash") && {
      messageHash: async (message: string) => (await request("messageHash", { message })) as string,
    }),
    ...(has("signMessage") && {
      signMessage: async (message: string, wif: string) => (await request("signMessage", { message, wif })) as string,
    }),
    ...(has("verifyMessage") && {
      verifyMessage: async (message: string, signature: string, signer: string, identity?: unknown) =>
        (await request("verifyMessage", { message, signature, signer, ...(identity !== undefined ? { identity } : {}) })) as boolean,
    }),
  };

  const close = (): Promise<void> =>
    new Promise((resolve) => {
      if (exited) {
        resolve();
        return;
      }
      const killTimer = setTimeout(() => child.kill("SIGKILL"), 3_000);
      child.once("exit", () => {
        clearTimeout(killTimer);
        resolve();
      });
      child.stdin.end();
    });

  return { target, declaredOps, close };
}
