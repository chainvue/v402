/**
 * Gated integration (VERUS_RPC_URL): the authoritative proof that locally
 * signed messages are accepted by verusd verifymessage — covering the
 * non-standard daemon nonce variant question (bytes differ, validity holds).
 */
import { describe, expect, it } from "vitest";
import { VerusRpcClient } from "@chainvue/v402-verus-rpc";
import {
  EnvSigner,
  LocalKeySigner,
  parseIdentitySignature,
  signIdentityMessageMultisig,
  verifyAddressSignature,
  verifyIdentitySignature,
  decodeWif,
  type IdentityState,
} from "../src/index.js";

const RPC_URL = process.env["VERUS_RPC_URL"];

const KEY_A = { wif: "Uw81VDAH8zrvbGJLfo1nfLaWN9tnGMo2U3bB81Zg8MKBvakrNXqP", address: "RXzn488JQaeEpo7iezaKiK1XLfRQzi2NWT" };
const KEY_B = { wif: "UsLMFdPY9HhXk7P9M6vuQweEaC9cNxQmWsbn7oJnc9z6qiKA55vd", address: "RLjrXPziU4Moc13vc2vGMvNpMmfM7ozZir" };

// v402test@ — dedicated vector identity, primary address = published key A
const V402TEST = {
  name: "v402test@",
  identityAddress: "iGnQaDzEcrFWg3J9Jg5MqPKCwo52Din4Ma",
  systemId: "iJhCezBExJHvtyH3fGhNnt2NhU4Ztkf2yq", // VRSCTEST
};

// v402multisig@ — dedicated 2-of-2 fixture identity (registered 2026-07-11):
// primaries = BOTH published test keys, minimumsignatures = 2, authorities
// v402revoke@/v402recover@. Never fund. Exists so the offline verifier's
// N-of-M path is exercised against real chain state.
const V402MULTISIG = {
  name: "v402multisig@",
  identityAddress: "iDM8ikjVtv6nTgw5VQUtQB1nu6Ketj4u1T",
  systemId: V402TEST.systemId,
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

  // Offline-verifier parity (Etappe 1.5): DAEMON-built signatures must pass
  // the local recovery-based verification — the reverse direction of the
  // signing tests above.
  it("a daemon address signature verifies offline", async () => {
    const message = "v402 offline parity probe (address)";
    const { signature } = await rpc.signMessage(KEY_A.address, message);
    expect(verifyAddressSignature(message, signature, KEY_A.address)).toBe(true);
    expect(verifyAddressSignature(message + "x", signature, KEY_A.address)).toBe(false);
    expect(verifyAddressSignature(message, signature, KEY_B.address)).toBe(false);
  });

  it("a daemon identity signature verifies offline against live getidentity state", async () => {
    const message = "v402 offline parity probe (identity)";
    const { signature } = await rpc.signMessage(V402TEST.name, message);
    const live = await rpc.getIdentity(V402TEST.name);
    const state: IdentityState = {
      identityAddress: live.identity.identityaddress,
      primaryAddresses: live.identity.primaryaddresses,
      minimumSignatures: live.identity.minimumsignatures,
      revoked: live.status === "revoked",
    };
    const result = verifyIdentitySignature(message, signature, live.identity.systemid, state);
    expect(result.valid).toBe(true);
    expect(verifyIdentitySignature("tampered", signature, live.identity.systemid, state).valid).toBe(false);
  });

  // N-of-M path against the live 2-of-2 fixture (v402multisig@).
  describe("2-of-2 multisig identity (v402multisig@)", () => {
    const liveState = async (): Promise<{ state: IdentityState; systemId: string }> => {
      const live = await rpc.getIdentity(V402MULTISIG.name);
      // fixture sanity — if this fails, the identity was tampered with
      expect(live.identity.identityaddress).toBe(V402MULTISIG.identityAddress);
      expect(live.identity.minimumsignatures).toBe(2);
      expect([...live.identity.primaryaddresses].sort()).toEqual([KEY_B.address, KEY_A.address].sort());
      return {
        state: {
          identityAddress: live.identity.identityaddress,
          primaryAddresses: live.identity.primaryaddresses,
          minimumSignatures: live.identity.minimumsignatures,
          revoked: live.status === "revoked",
        },
        systemId: live.identity.systemid,
      };
    };

    it("a locally built 2-of-2 signature verifies via verifymessage AND offline", async () => {
      const message = "v402 multisig probe (local 2-of-2)";
      const height = await rpc.getBlockCount();
      const signature = signIdentityMessageMultisig(message, [decodeWif(KEY_A.wif), decodeWif(KEY_B.wif)], {
        blockHeight: height,
        systemId: V402MULTISIG.systemId,
        identityAddress: V402MULTISIG.identityAddress,
      });
      expect(await rpc.verifyMessage(V402MULTISIG.name, signature, message)).toBe(true);
      const { state, systemId } = await liveState();
      expect(verifyIdentitySignature(message, signature, systemId, state).valid).toBe(true);
      expect(verifyIdentitySignature(message + "x", signature, systemId, state).valid).toBe(false);
    });

    it("a single signature is rejected by the daemon AND offline (insufficient for 2-of-2)", async () => {
      const message = "v402 multisig probe (1 sig, must fail)";
      const height = await rpc.getBlockCount();
      const signature = signIdentityMessageMultisig(message, [decodeWif(KEY_A.wif)], {
        blockHeight: height,
        systemId: V402MULTISIG.systemId,
        identityAddress: V402MULTISIG.identityAddress,
      });
      expect(await rpc.verifyMessage(V402MULTISIG.name, signature, message)).toBe(false);
      const { state, systemId } = await liveState();
      const result = verifyIdentitySignature(message, signature, systemId, state);
      expect(result.valid).toBe(false);
      expect(result.matchedAddresses).toEqual([KEY_A.address]);
    });

    it("a daemon-built multisig signature verifies offline (parity)", async () => {
      const message = "v402 multisig probe (daemon)";
      const { signature } = await rpc.signMessage(V402MULTISIG.name, message);
      expect(parseIdentitySignature(signature).signatures).toHaveLength(2);
      const { state, systemId } = await liveState();
      expect(verifyIdentitySignature(message, signature, systemId, state).valid).toBe(true);
    });
  });
});
