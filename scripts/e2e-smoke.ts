/**
 * End-to-end smoke test against a running v402 stack (plan step 22) —
 * normally the docker-compose pair (facilitator :3000 + demo-server :3001).
 *
 *   pnpm smoke        # SMOKE_DEPOSIT_MODE=simulated (default; admin endpoint)
 *   SMOKE_DEPOSIT_MODE=real pnpm smoke   # prints topup instructions and
 *                                        # polls until the on-chain deposit credits
 *
 * Required env: V402_ADMIN_TOKEN (simulated variant), VERUS_RPC_URL/USER/PASS
 * (NodeSigner — the payer identity's wallet), SMOKE_PAYER (default v402-agent@).
 * Signature verification always runs against the real Verus node via the
 * facilitator; only the deposit path differs between variants.
 */
import { humanToSats, satsToHuman } from "@chainvue/v402-protocol";
import { V402Client, wrapFetchWithPayment } from "@chainvue/v402-client-fetch";
import { NodeSigner } from "@chainvue/v402-signer-verus";

const FACILITATOR = (process.env["FACILITATOR_URL"] ?? "http://localhost:3000").replace(/\/$/, "");
const DEMO = (process.env["DEMO_URL"] ?? "http://localhost:3001").replace(/\/$/, "");
const PAYER = process.env["SMOKE_PAYER"] ?? "v402-agent@";
const ADMIN_TOKEN = process.env["V402_ADMIN_TOKEN"] ?? "";
const DEPOSIT_MODE = process.env["SMOKE_DEPOSIT_MODE"] ?? "simulated";
const DEPOSIT_AMOUNT = "1";

let step = 0;
function log(message: string): void {
  console.log(`[smoke ${String(++step).padStart(2, "0")}] ${message}`);
}
function fail(message: string): never {
  console.error(`\nSMOKE FAILED: ${message}`);
  process.exit(1);
}
function assertEqual<T>(actual: T, expected: T, what: string): void {
  if (actual !== expected) fail(`${what}: expected ${String(expected)}, got ${String(actual)}`);
}

async function json(url: string, init?: RequestInit): Promise<{ status: number; body: any }> {
  const response = await fetch(url, init);
  return { status: response.status, body: await response.json().catch(() => ({})) };
}

async function main(): Promise<void> {
  const signer = new NodeSigner({
    signer: PAYER,
    rpc: {
      rpcUrl: process.env["VERUS_RPC_URL"] ?? "http://127.0.0.1:18843",
      rpcUser: process.env["VERUS_RPC_USER"] ?? "",
      rpcPass: process.env["VERUS_RPC_PASS"] ?? "",
      circuit: { timeoutMs: 15_000 },
    },
  });
  const client = new V402Client({ identity: PAYER, signer, facilitator: FACILITATOR });
  const paidFetch = wrapFetchWithPayment(fetch, { payer: PAYER, signer });

  // 1. stack alive
  const health = await json(`${FACILITATOR}/v1/health`);
  assertEqual(health.status, 200, "facilitator health");
  log(`facilitator healthy (watcher=${health.body.watcher.mode}, rpc reachable=${health.body.verusRpc.reachable})`);
  const rateCard = await json(`${DEMO}/.well-known/v402`);
  assertEqual(rateCard.status, 200, "demo discovery/rate card");
  log(`demo-server up (${rateCard.body.endpoints.length} priced endpoints via /.well-known/v402)`);
  const discovery = await client.discover();
  assertEqual(discovery.defaultVersion, "v402/0.1", "discovery defaultVersion");
  log(`discovery ok (schemes: ${(discovery as any).schemes.map((s: any) => s.scheme).join(", ")})`);

  // 2. unpaid request → 402 challenge
  const challenge = await json(`${DEMO}/api/status`);
  assertEqual(challenge.status, 402, "unpaid challenge status");
  log(`402 challenge with accepts[0].amount=${challenge.body.accepts[0].amount}`);

  // 3. deposit → credit
  const before = await client.getBalance().catch(() => undefined);
  const beforeSats = BigInt(before?.availableSats ?? "0");
  if (DEPOSIT_MODE === "simulated") {
    if (ADMIN_TOKEN === "") fail("V402_ADMIN_TOKEN required for the simulated deposit variant");
    const credited = await json(`${FACILITATOR}/admin/simulate-deposit`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${ADMIN_TOKEN}` },
      body: JSON.stringify({ identity: PAYER, amount: DEPOSIT_AMOUNT }),
    });
    assertEqual(credited.status, 201, "simulate-deposit");
    log(`simulated deposit credited (balance ${satsToHuman(BigInt(credited.body.balanceAfterSats))})`);
  } else {
    const topup = await client.getTopupInstructions({ amount: DEPOSIT_AMOUNT });
    console.log("\nSend the real deposit now:\n  " + (topup as any).instructions.text + "\n");
    const target = beforeSats + humanToSats(DEPOSIT_AMOUNT);
    const deadline = Date.now() + Number(process.env["SMOKE_DEPOSIT_TIMEOUT_MS"] ?? 20 * 60_000);
    for (;;) {
      const balance = await client.getBalance().catch(() => undefined);
      if (balance !== undefined && BigInt(balance.availableSats) >= target) break;
      if (Date.now() > deadline) fail("on-chain deposit not credited within the timeout");
      log("waiting for on-chain credit…");
      await new Promise((resolve) => setTimeout(resolve, 30_000));
    }
    log("on-chain deposit credited");
  }

  const funded = await client.getBalance();
  log(`balance: available=${funded.available} reserved=${funded.reserved}`);

  // 4. paid requests across price points + bodyHash POST
  const status = await paidFetch(`${DEMO}/api/status`);
  assertEqual(status.status, 200, "paid /api/status");
  log(`paid /api/status ok (X-V402-Balance=${status.headers.get("x-v402-balance")})`);

  const tx = await paidFetch(`${DEMO}/api/tx/smoke123`);
  assertEqual(tx.status, 200, "paid /api/tx");
  assertEqual(((await tx.json()) as any).txid, "smoke123", "tx echo");
  log("paid /api/tx ok");

  const graphql = await paidFetch(`${DEMO}/api/graphql`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ query: "{ smoke }" }),
  });
  assertEqual(graphql.status, 201, "paid bodyHash POST");
  log("paid POST /api/graphql with scheme.bodyHash ok");

  // 5. exact accounting: 0.0001 + 0.001 + 0.002 spent
  const spent = humanToSats("0.0001") + humanToSats("0.001") + humanToSats("0.002");
  const after = await client.getBalance();
  const expected = BigInt(funded.availableSats) - spent;
  assertEqual(after.availableSats, expected.toString(), "post-spend available balance");
  log(`exact debit verified (spent ${satsToHuman(spent)}, available ${after.available})`);

  // 6. replay protection: resend a captured payment verbatim → 409
  const replayHeaders: Record<string, string> = {};
  const capturingFetch: typeof fetch = async (url, init) => {
    new Headers(init?.headers).forEach((value, name) => {
      if (name.startsWith("x-v402")) replayHeaders[name] = value;
    });
    return fetch(url, init);
  };
  const paidOnce = await wrapFetchWithPayment(capturingFetch, { payer: PAYER, signer })(`${DEMO}/api/status`);
  assertEqual(paidOnce.status, 200, "capture request");
  const replay = await json(`${DEMO}/api/status`, { headers: replayHeaders });
  assertEqual(replay.status, 409, "replay status");
  assertEqual(replay.body.error.details.previousStatus, "committed", "replay previousStatus");
  log("replay correctly rejected with 409/committed");

  console.log("\nSMOKE PASSED — full 402 handshake, deposit credit, exact debit, bodyHash binding, replay protection.");
}

main().catch((err: unknown) => fail(err instanceof Error ? (err.stack ?? err.message) : String(err)));
