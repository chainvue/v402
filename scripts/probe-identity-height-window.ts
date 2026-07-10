/**
 * Empirical steward probe: which embedded block heights does verusd
 * verifymessage accept in a VerusID identity signature?
 *
 * Background: identity signatures embed the signing height (bytes 1-4); the
 * verifier resolves the identity's primary addresses AT that height. This
 * probe signs as v402test@ (published test key A) with hand-picked heights
 * and asks the daemon. Findings are recorded in docs/RISKS.md (Layer 6).
 *
 * Usage: VERUS_RPC_URL=… VERUS_RPC_USER=… VERUS_RPC_PASS=… \
 *          node scripts/probe-identity-height-window.ts
 */
import { decodeWif, signIdentityMessage } from "@chainvue/v402-signer-verus";

const KEY_A_WIF = "Uw81VDAH8zrvbGJLfo1nfLaWN9tnGMo2U3bB81Zg8MKBvakrNXqP";
const IDENTITY = "v402test@";
const IDENTITY_ADDRESS = "iGnQaDzEcrFWg3J9Jg5MqPKCwo52Din4Ma";
const SYSTEM_ID = "iJhCezBExJHvtyH3fGhNnt2NhU4Ztkf2yq"; // VRSCTEST
const REGISTRATION_HEIGHT = 1_141_245; // v402test@ registration block on VRSCTEST

const { VERUS_RPC_URL, VERUS_RPC_USER, VERUS_RPC_PASS } = process.env;
if (!VERUS_RPC_URL || !VERUS_RPC_USER || !VERUS_RPC_PASS) {
  console.error("VERUS_RPC_URL/_USER/_PASS required");
  process.exit(1);
}

async function rpc(method: string, params: unknown[]): Promise<unknown> {
  const response = await fetch(VERUS_RPC_URL!, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: "Basic " + Buffer.from(`${VERUS_RPC_USER}:${VERUS_RPC_PASS}`).toString("base64"),
    },
    body: JSON.stringify({ jsonrpc: "1.0", id: "height-probe", method, params }),
  });
  const body = (await response.json()) as { result?: unknown; error?: { code: number; message: string } };
  if (body.error) throw new Error(`${method}: ${body.error.message} (${body.error.code})`);
  return body.result;
}

const priv = decodeWif(KEY_A_WIF);
const tip = (await rpc("getblockcount", [])) as number;
console.log(`tip=${tip} registration=${REGISTRATION_HEIGHT} (identity age: ${tip - REGISTRATION_HEIGHT} blocks)`);

const message = "v402 height-window probe";
const heights: Array<[string, number]> = [
  ["tip", tip],
  ["tip-1", tip - 1],
  ["tip-5", tip - 5],
  ["registration", REGISTRATION_HEIGHT],
  ["registration-1 (pre-ID)", REGISTRATION_HEIGHT - 1],
  ["registration-10 (pre-ID)", REGISTRATION_HEIGHT - 10],
  ["100k ago (pre-ID)", tip - 100_000],
  ["height 1", 1],
  ["height 0", 0],
  ["tip+1 (future)", tip + 1],
  ["tip+10 (future)", tip + 10],
  ["tip+100 (future)", tip + 100],
  ["tip+10000 (future)", tip + 10_000],
  ["max uint32", 0xffff_ffff],
];

for (const [label, height] of heights) {
  if (height <= 0 || height > 0xffff_ffff) {
    console.log(`${label.padEnd(26)} h=${String(height).padStart(10)} → skipped (invalid uint32 for the wrapper)`);
    continue;
  }
  const signature = signIdentityMessage(message, priv, {
    blockHeight: height,
    systemId: SYSTEM_ID,
    identityAddress: IDENTITY_ADDRESS,
  });
  let verdict: string;
  try {
    verdict = ((await rpc("verifymessage", [IDENTITY, signature, message])) as boolean) ? "ACCEPT" : "reject";
  } catch (err) {
    verdict = `RPC error: ${(err as Error).message}`;
  }
  console.log(`${label.padEnd(26)} h=${String(height).padStart(10)} → ${verdict}`);
}
