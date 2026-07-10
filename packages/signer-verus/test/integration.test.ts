/**
 * Gated integration (VERUS_RPC_URL): the authoritative proof that locally
 * signed messages are accepted by verusd verifymessage — covering the
 * non-standard daemon nonce variant question (bytes differ, validity holds).
 */
import { describe, expect, it } from "vitest";
import { VerusRpcClient } from "@chainvue/v402-verus-rpc";
import { EnvSigner, LocalKeySigner } from "../src/index.js";

const RPC_URL = process.env["VERUS_RPC_URL"];

const KEY_A = { wif: "Uw81VDAH8zrvbGJLfo1nfLaWN9tnGMo2U3bB81Zg8MKBvakrNXqP", address: "RXzn488JQaeEpo7iezaKiK1XLfRQzi2NWT" };
const KEY_B = { wif: "UsLMFdPY9HhXk7P9M6vuQweEaC9cNxQmWsbn7oJnc9z6qiKA55vd", address: "RLjrXPziU4Moc13vc2vGMvNpMmfM7ozZir" };

// v402test@ — dedicated vector identity, primary address = published key A
const V402TEST = {
  name: "v402test@",
  identityAddress: "iGnQaDzEcrFWg3J9Jg5MqPKCwo52Din4Ma",
  systemId: "iJhCezBExJHvtyH3fGhNnt2NhU4Ztkf2yq", // VRSCTEST
};

describe.skipIf(!RPC_URL)("signer-verus integration (VRSCTEST)", () => {
  const rpc = new VerusRpcClient({
    rpcUrl: RPC_URL ?? "",
    rpcUser: process.env["VERUS_RPC_USER"] ?? "",
    rpcPass: process.env["VERUS_RPC_PASS"] ?? "",
    circuit: { timeoutMs: 15_000 },
  });

  it.each([
    ["key A", KEY_A],
    ["key B", KEY_B],
  ])("locally signed messages verify via verifymessage (%s)", async (_name, key) => {
    const signer = new EnvSigner({ env: { VERUS_SIGNING_KEY: key.wif } });
    const multiline = "verus-prepaid-sig/0.1\ncanonicalDomain: explorer.example.com\nmethod: GET\nlocal signer probe";
    for (const message of ["v402 local signer probe", multiline]) {
      const signature = await signer.signMessage(message);
      expect(await rpc.verifyMessage(key.address, signature, message)).toBe(true);
    }
  });

  it("a tampered message does not verify", async () => {
    const signer = new EnvSigner({ env: { VERUS_SIGNING_KEY: KEY_A.wif } });
    const signature = await signer.signMessage("original");
    expect(await rpc.verifyMessage(KEY_A.address, signature, "tampered")).toBe(false);
  });

  it("a locally built IDENTITY signature verifies as v402test@ (D2)", async () => {
    const signer = new LocalKeySigner(KEY_A.wif, {
      identity: V402TEST,
      heightProvider: () => rpc.getBlockCount(),
    });
    const multiline = "verus-prepaid-sig/0.1\ncanonicalDomain: explorer.example.com\nmethod: GET\nidentity signer probe";
    for (const message of ["v402 local identity signer probe", multiline]) {
      const signature = await signer.signMessage(message);
      expect(await rpc.verifyMessage(V402TEST.name, signature, message)).toBe(true);
    }
  });

  it("a tampered identity-signed message does not verify", async () => {
    const signer = new LocalKeySigner(KEY_A.wif, {
      identity: V402TEST,
      heightProvider: () => rpc.getBlockCount(),
    });
    const signature = await signer.signMessage("original");
    expect(await rpc.verifyMessage(V402TEST.name, signature, "tampered")).toBe(false);
  });
});
