import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readFileSync } from "node:fs";
import { afterAll, describe, expect, it } from "vitest";
import { secp256k1 } from "@noble/curves/secp256k1.js";
import { MockVerusRpc } from "@chainvue/v402-verus-rpc";
import {
  EnvSigner,
  FileSigner,
  LocalKeySigner,
  NodeSigner,
  decodeIAddress,
  decodeWif,
  signAddressMessage,
  signIdentityMessage,
  verusIdentitySignDigest,
  verusMessageHash,
  verusSignDigest,
  wrapIdentitySignature,
} from "../src/index.js";

interface VectorCase {
  name: string;
  input: { signer: string; wif: string | null; message: string };
  expected: { signature: string; hash: string; assert: string };
}

function loadSigningVectors(): VectorCase[] {
  const url = new URL("../../../spec/0.1/test-vectors/signing.json", import.meta.url);
  return (JSON.parse(readFileSync(url, "utf8")) as { cases: VectorCase[] }).cases;
}

const KEY_A_WIF = "Uw81VDAH8zrvbGJLfo1nfLaWN9tnGMo2U3bB81Zg8MKBvakrNXqP";
const KEY_A_SEED = "v402-test-vectors/0.1 key A";

describe("decodeWif", () => {
  it("recovers the documented seed-derived private key", () => {
    const expected = createHash("sha256").update(KEY_A_SEED, "utf8").digest();
    expect(Buffer.from(decodeWif(KEY_A_WIF))).toEqual(expected);
  });

  it.each([
    ["garbage", "x"],
    ["bad checksum", "Uw81VDAH8zrvbGJLfo1nfLaWN9tnGMo2U3bB81Zg8MKBvakrNXqQ"],
    ["invalid base58 char", "0w81VDAH8zrvbGJLfo1nfLaWN9tnGMo2U3bB81Zg8MKBvakrNXqP"],
  ])("rejects %s", (_name, wif) => {
    expect(() => decodeWif(wif)).toThrow();
  });
});

describe("verusMessageHash", () => {
  it.each([
    // recorded from verusd 1.2.17 signmessage output
    ["v402 determinism probe", "66bcf44e0bd6149137c81944db916a9b7fb3feae19ac926add0d3d1c442456dd"],
    ["v402 signer probe", "40cc3d47a66282a4ecdb56d60e094cb00dc04eb510888a87070ba65b47679b7c"],
  ])("matches the daemon hash for %j", (message, expected) => {
    expect(Buffer.from(verusMessageHash(message)).toString("hex")).toBe(expected);
  });
});

describe("local signing — daemon compatibility via the reference vectors", () => {
  function recoveredPubkey(signatureBase64: string, message: string): string {
    const raw = Buffer.from(signatureBase64, "base64");
    const signature = secp256k1.Signature.fromBytes(raw.subarray(1), "compact").addRecoveryBit(raw[0]! - 27 - 4);
    return Buffer.from(signature.recoverPublicKey(verusSignDigest(message)).toBytes(true)).toString("hex");
  }

  it("agrees with the daemon on hash, digest and key for every signature-equal vector", () => {
    const cases = loadSigningVectors().filter((c) => c.expected.assert === "signature-equal");
    expect(cases.length).toBeGreaterThanOrEqual(5);
    for (const testCase of cases) {
      const privateKey = decodeWif(testCase.input.wif!);
      const expectedPubkey = Buffer.from(secp256k1.getPublicKey(privateKey, true)).toString("hex");
      // 1. our message hash equals the daemon's reported hash
      expect(Buffer.from(verusMessageHash(testCase.input.message)).toString("hex"), testCase.name).toBe(
        testCase.expected.hash,
      );
      // 2. the DAEMON's signature recovers the vector key over OUR digest
      //    — proves the digest construction end-to-end
      expect(recoveredPubkey(testCase.expected.signature, testCase.input.message), testCase.name).toBe(expectedPubkey);
      // 3. OUR signature recovers the same key over the same digest — valid
      //    for verifymessage. (Bytes differ: verusd uses a non-standard
      //    RFC 6979 nonce variant; recovery-based verification is unaffected.
      //    The gated integration suite proves acceptance via verifymessage.)
      expect(recoveredPubkey(signAddressMessage(testCase.input.message, privateKey), testCase.input.message)).toBe(
        expectedPubkey,
      );
    }
  });

  it("signs deterministically (pure RFC 6979, no hedged nonces)", () => {
    const privateKey = decodeWif(KEY_A_WIF);
    expect(signAddressMessage("determinism", privateKey)).toBe(signAddressMessage("determinism", privateKey));
  });
});

describe("identity signatures (v402test@ / VRSCTEST)", () => {
  // real daemon output: signmessage "v402test@" "v402 height-window probe"
  // at height 1141273. v402test@'s only primary address is test key A, so
  // the daemon's inner compact signature must recover key A's pubkey over
  // OUR identity digest — the offline proof of the digest construction.
  const DAEMON_IDENTITY_SIG =
    "ARlqEQABQR+tkzYBpTgEU+da7ZSxL/rhWQdE6PlYndvFBb+MVg4rJUJg6NMXKbIDCBsdKcVKMpWSjNSKhFC/lakv6FPAA6sQ";
  const MESSAGE = "v402 height-window probe";
  const HEIGHT = 1_141_273;
  const IDENTITY = {
    identityAddress: "iGnQaDzEcrFWg3J9Jg5MqPKCwo52Din4Ma", // v402test@
    systemId: "iJhCezBExJHvtyH3fGhNnt2NhU4Ztkf2yq", // VRSCTEST
  };
  const identityDigest = () =>
    verusIdentitySignDigest(MESSAGE, decodeIAddress(IDENTITY.systemId), HEIGHT, decodeIAddress(IDENTITY.identityAddress));

  function recoverOverDigest(compact65: Buffer, digest: Uint8Array): string {
    const signature = secp256k1.Signature.fromBytes(compact65.subarray(1), "compact").addRecoveryBit(compact65[0]! - 27 - 4);
    return Buffer.from(signature.recoverPublicKey(digest).toBytes(true)).toString("hex");
  }

  it("round-trips the daemon's identity signature envelope exactly", () => {
    const raw = Buffer.from(DAEMON_IDENTITY_SIG, "base64");
    expect(raw).toHaveLength(72);
    expect(raw[0]).toBe(0x01); // version
    expect(raw.readUInt32LE(1)).toBe(HEIGHT);
    expect(raw[5]).toBe(0x01); // one signature
    expect(raw[6]).toBe(0x41); // 65-byte entry
    expect(wrapIdentitySignature(raw.subarray(7).toString("base64"), HEIGHT)).toBe(DAEMON_IDENTITY_SIG);
  });

  it("the DAEMON's identity signature recovers key A over OUR identity digest (offline digest proof)", () => {
    // identity digest = sha256(ser(prefix) || systemID || height LE32 || idID || msgHash)
    // — binds chain, height and identity; a plain address digest would NOT recover key A here
    const raw = Buffer.from(DAEMON_IDENTITY_SIG, "base64");
    const expectedPubkey = Buffer.from(secp256k1.getPublicKey(decodeWif(KEY_A_WIF), true)).toString("hex");
    expect(recoverOverDigest(Buffer.from(raw.subarray(7)), identityDigest())).toBe(expectedPubkey);
    expect(recoverOverDigest(Buffer.from(raw.subarray(7)), verusSignDigest(MESSAGE))).not.toBe(expectedPubkey);
  });

  it("our identity signature signs the identity digest and embeds the height", () => {
    const signature = signIdentityMessage(MESSAGE, decodeWif(KEY_A_WIF), { blockHeight: HEIGHT, ...IDENTITY });
    const raw = Buffer.from(signature, "base64");
    expect(raw).toHaveLength(72);
    expect(raw.readUInt32LE(1)).toBe(HEIGHT);
    const expectedPubkey = Buffer.from(secp256k1.getPublicKey(decodeWif(KEY_A_WIF), true)).toString("hex");
    expect(recoverOverDigest(Buffer.from(raw.subarray(7)), identityDigest())).toBe(expectedPubkey);
  });

  it("requires a height provider for identity mode", () => {
    expect(() => new LocalKeySigner(KEY_A_WIF, { identity: IDENTITY })).toThrow(/heightProvider/);
  });

  it("LocalKeySigner identity mode signs via the height provider", async () => {
    const signer = new LocalKeySigner(KEY_A_WIF, { identity: IDENTITY, heightProvider: async () => HEIGHT });
    expect(await signer.signMessage(MESSAGE)).toBe(
      signIdentityMessage(MESSAGE, decodeWif(KEY_A_WIF), { blockHeight: HEIGHT, ...IDENTITY }),
    );
  });

  it("decodeIAddress rejects R-addresses and garbage", () => {
    expect(() => decodeIAddress("RXzn488JQaeEpo7iezaKiK1XLfRQzi2NWT")).toThrow(/version/);
    expect(() => decodeIAddress("not-an-address")).toThrow();
  });
});

describe("EnvSigner / FileSigner / NodeSigner", () => {
  const dir = mkdtempSync(join(tmpdir(), "v402-signer-"));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it("EnvSigner reads the WIF from the (injected) environment", async () => {
    const signer = new EnvSigner({ env: { VERUS_SIGNING_KEY: KEY_A_WIF } });
    expect(await signer.signMessage("test")).toBe(signAddressMessage("test", decodeWif(KEY_A_WIF)));
    expect(() => new EnvSigner({ env: {} })).toThrow(/VERUS_SIGNING_KEY/);
  });

  it("FileSigner enforces mode 0600", async () => {
    const keyPath = join(dir, "key.wif");
    writeFileSync(keyPath, `${KEY_A_WIF}\n`);
    chmodSync(keyPath, 0o644);
    expect(() => new FileSigner({ path: keyPath })).toThrow(/chmod 600/);
    chmodSync(keyPath, 0o600);
    const signer = new FileSigner({ path: keyPath });
    expect(await signer.signMessage("test")).toBe(signAddressMessage("test", decodeWif(KEY_A_WIF)));
  });

  it("NodeSigner delegates to the daemon and returns the signature field", async () => {
    const rpc = new MockVerusRpc({
      signMessage: async (signer, message) => ({ hash: "ab".repeat(32), signature: `sig(${signer},${message})` }),
    });
    const signer = new NodeSigner({ signer: "v402.demoAgent@", rpcClient: rpc });
    expect(await signer.signMessage("canonical")).toBe("sig(v402.demoAgent@,canonical)");
    expect(rpc.calls).toEqual([{ method: "signMessage", params: ["v402.demoAgent@", "canonical"] }]);
  });
});
