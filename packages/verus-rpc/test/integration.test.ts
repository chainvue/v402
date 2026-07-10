/**
 * Integration suite against a real VRSCTEST node — gated behind VERUS_RPC_URL
 * (testing strategy: CI runs without it; full-integration runs on demand):
 *
 *   VERUS_RPC_URL=http://127.0.0.1:18843 VERUS_RPC_USER=… VERUS_RPC_PASS=… pnpm test
 *
 * This is also the cryptographic CI gate for the reference test vectors:
 * every signing.json signature and every verification.json case is checked
 * against the daemon's verifymessage.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { VerusRpcClient, VerusRpcError } from "../src/index.js";

const RPC_URL = process.env["VERUS_RPC_URL"];

interface VectorCase {
  name: string;
  input: Record<string, unknown>;
  expected: Record<string, unknown>;
}

function loadCases(file: string): VectorCase[] {
  const url = new URL(`../../../spec/0.1/test-vectors/${file}`, import.meta.url);
  return (JSON.parse(readFileSync(url, "utf8")) as { cases: VectorCase[] }).cases;
}

describe.skipIf(!RPC_URL)("verus-rpc integration (VRSCTEST)", () => {
  const client = new VerusRpcClient({
    rpcUrl: RPC_URL ?? "",
    rpcUser: process.env["VERUS_RPC_USER"] ?? "",
    rpcPass: process.env["VERUS_RPC_PASS"] ?? "",
    // generous timeout: integration correctness, not latency, is under test
    circuit: { timeoutMs: 10_000 },
  });

  it("getInfo reports the VRSCTEST chain", async () => {
    const info = await client.getInfo();
    expect(info.name).toBe("VRSCTEST");
    expect(info.blocks).toBeGreaterThan(0);
  });

  it("getBlockCount / getBlock / getRawTransaction round-trip", async () => {
    const height = await client.getBlockCount();
    const block = await client.getBlock(height - 10);
    expect(block.height).toBe(height - 10);
    expect(block.tx.length).toBeGreaterThan(0);
    const tx = await client.getRawTransaction(block.tx[0]!);
    expect(tx.txid).toBe(block.tx[0]);
    expect(tx.vout.length).toBeGreaterThan(0);
  });

  it("getIdentity resolves the vector identity v402test@", async () => {
    const result = await client.getIdentity("v402test@");
    expect(result.identity.identityaddress).toBe("iGnQaDzEcrFWg3J9Jg5MqPKCwo52Din4Ma");
    expect(result.identity.primaryaddresses).toEqual(["RXzn488JQaeEpo7iezaKiK1XLfRQzi2NWT"]);
  });

  describe("cryptographic vector gate — signing.json", () => {
    it.each(loadCases("signing.json"))("$name verifies against the daemon", async ({ input, expected }) => {
      const valid = await client.verifyMessage(
        input["signer"] as string,
        expected["signature"] as string,
        input["message"] as string,
      );
      expect(valid).toBe(true);
      // checkLatest=true is what the v402 verifier sends — must also hold
      // while the identity's keys are unchanged (daemon 4-param form)
      const validLatest = await client.verifyMessage(
        input["signer"] as string,
        expected["signature"] as string,
        input["message"] as string,
        true,
      );
      expect(validLatest).toBe(true);
    });
  });

  describe("cryptographic vector gate — verification.json", () => {
    it.each(loadCases("verification.json"))("$name", async ({ input, expected }) => {
      const run = client.verifyMessage(
        input["signer"] as string,
        input["signature"] as string,
        input["message"] as string,
      );
      if (expected["reason"] === "malformed-signature-encoding") {
        // daemon answers with a JSON-RPC error — protocol semantic: reject
        await expect(run).rejects.toBeInstanceOf(VerusRpcError);
      } else {
        await expect(run).resolves.toBe(expected["accept"]);
      }
    });
  });
});
