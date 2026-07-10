/**
 * Deterministic generator for the v402/0.1 reference test vectors
 * (spec/0.1/test-vectors/). Run via:
 *
 *   pnpm generate:vectors
 *
 * Pure categories (canonical, extensions, boundary, wire-format) are always
 * regenerated. Signing + verification vectors need a Verus testnet node and
 * are only regenerated when VERUS_RPC_URL / VERUS_RPC_USER / VERUS_RPC_PASS
 * are set — `verus signmessage` was confirmed deterministic (v1.2.17), so
 * address-key signatures are byte-stable across regenerations. VerusID
 * signatures embed the signing block height and are therefore verify-only.
 *
 * Requires the workspace build of @chainvue/v402-protocol (the pnpm script
 * builds it first). Runs on plain Node >= 22 (type stripping).
 */
import { writeFileSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  V402ProtocolError,
  canonicalize,
  canonicalizeBalanceQuery,
  humanToSats,
  parseExtensionBlock,
  satsToHuman,
  serializeExtensionBlock,
  type CanonicalPayload,
} from "@chainvue/v402-protocol";

const SPEC = "verus-prepaid-sig-v0.1";
const OUT_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "spec", "0.1", "test-vectors");

interface TestCase {
  name: string;
  spec: string;
  input: Record<string, unknown>;
  expected: Record<string, unknown>;
}

function writeVectors(file: string, category: string, cases: TestCase[], meta?: Record<string, unknown>): void {
  const doc = {
    category,
    generator: "scripts/generate-vectors.ts",
    ...meta,
    cases,
  };
  writeFileSync(join(OUT_DIR, file), JSON.stringify(doc, null, 2) + "\n");
  console.log(`wrote ${file} (${cases.length} cases)`);
}

function errorCode(fn: () => unknown): string {
  try {
    fn();
  } catch (err) {
    if (err instanceof V402ProtocolError) return err.code;
    throw err;
  }
  throw new Error("expected V402ProtocolError, nothing was thrown");
}

// ─── Reference payloads ──────────────────────────────────────────────────────

const getMinimal: CanonicalPayload = {
  scheme: "verus-prepaid-sig",
  schemeVersion: "0.1",
  canonicalDomain: "explorer.example.com",
  method: "GET",
  path: "/api/tx/abc",
  network: "vrsctest",
  asset: "VRSCTEST",
  amount: "0.001",
  payer: "v402test.demoAgent@",
  payTo: "explorerAPI@",
  requestId: "01H8XG7Q4M2N8P5R7T3V9WXYZA",
  issuedAt: 1783650000,
};

const postWithExtensions: CanonicalPayload = {
  ...getMinimal,
  canonicalDomain: "example.com",
  method: "POST",
  path: "/api/upload",
  amount: "0.005",
  extensions: [
    { key: "x-mystartup.orderId", value: "ord_12345" },
    { key: "scheme.bodyHash", value: "sha256:a1b2c3d4e5f6" },
  ],
};

const balanceQuery = {
  canonicalDomain: "facilitator.example.com",
  network: "vrsctest",
  payer: "v402.demoAgent@",
  requestId: "01H8XGABCDEF0123456789QRST",
  issuedAt: 1783650000,
};

const paymentPayloads: Record<string, CanonicalPayload> = {
  "get-minimal": getMinimal,
  "post-with-extensions": postWithExtensions,
  "path-with-query-string": { ...getMinimal, path: "/api/search?q=foo%20bar&limit=10" },
  "path-with-trailing-slash": { ...getMinimal, path: "/api/blocks/" },
  "unicode-payer": { ...getMinimal, payer: "v402.日本語@" },
  "amount-trailing-zeros": { ...getMinimal, amount: "1.99999000" },
  "amount-max-uint64-sats": { ...getMinimal, amount: "184467440737.09551616" },
  "issued-at-zero": { ...getMinimal, issuedAt: 0 },
  "three-extensions-sorted": {
    ...getMinimal,
    method: "POST",
    path: "/graphql",
    extensions: [
      { key: "x-mystartup.orderId", value: "ord_12345" },
      { key: "iana.reserved", value: "do-not-use-yet" },
      { key: "scheme.bodyHash", value: "sha256:2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824" },
    ],
  },
};

// ─── canonical.json ──────────────────────────────────────────────────────────

const canonicalCases: TestCase[] = Object.entries(paymentPayloads).map(([name, payload]) => ({
  name,
  spec: SPEC,
  input: { payloadType: "payment", payload },
  expected: { canonical: canonicalize(payload) },
}));
canonicalCases.push({
  name: "balance-query",
  spec: SPEC,
  input: { payloadType: "balanceQuery", payload: balanceQuery },
  expected: { canonical: canonicalizeBalanceQuery(balanceQuery) },
});

// ─── extensions.json ─────────────────────────────────────────────────────────

const unsortedFields = [
  { key: "x-mystartup.orderId", value: "ord_12345" },
  { key: "iana.reserved", value: "x" },
  { key: "scheme.bodyHash", value: "sha256:abc" },
];

const extensionsCases: TestCase[] = [
  {
    name: "serialize-sorts-input",
    spec: SPEC,
    input: { op: "serialize", fields: unsortedFields },
    expected: { block: serializeExtensionBlock(unsortedFields) },
  },
  {
    name: "serialize-duplicate-key",
    spec: SPEC,
    input: {
      op: "serialize",
      fields: [
        { key: "scheme.bodyHash", value: "a" },
        { key: "scheme.bodyHash", value: "b" },
      ],
    },
    expected: { error: "extensions-duplicate-key" },
  },
  {
    name: "serialize-unknown-prefix",
    spec: SPEC,
    input: { op: "serialize", fields: [{ key: "foo.bar", value: "v" }] },
    expected: { error: "invalid-extension-key" },
  },
  {
    name: "serialize-value-leading-space",
    spec: SPEC,
    input: { op: "serialize", fields: [{ key: "scheme.bodyHash", value: " a" }] },
    expected: { error: "invalid-extension-value" },
  },
  {
    name: "parse-round-trip",
    spec: SPEC,
    input: { op: "parse", block: "scheme.bodyHash: sha256:abc\nx-mystartup.orderId: ord_12345" },
    expected: {
      fields: [
        { key: "scheme.bodyHash", value: "sha256:abc" },
        { key: "x-mystartup.orderId", value: "ord_12345" },
      ],
    },
  },
  {
    name: "parse-value-with-colons",
    spec: SPEC,
    input: { op: "parse", block: "scheme.bodyHash: sha256:a: b" },
    expected: { fields: [{ key: "scheme.bodyHash", value: "sha256:a: b" }] },
  },
  {
    name: "parse-empty-block",
    spec: SPEC,
    input: { op: "parse", block: "" },
    expected: { fields: [] },
  },
  {
    name: "parse-unsorted",
    spec: SPEC,
    input: { op: "parse", block: "x-a.b: 1\nscheme.bodyHash: a" },
    expected: { error: "extensions-unsorted" },
  },
  {
    name: "parse-duplicate-key",
    spec: SPEC,
    input: { op: "parse", block: "scheme.bodyHash: a\nscheme.bodyHash: b" },
    expected: { error: "extensions-duplicate-key" },
  },
  {
    name: "parse-trailing-newline",
    spec: SPEC,
    input: { op: "parse", block: "scheme.bodyHash: a\n" },
    expected: { error: "invalid-extension-block" },
  },
  {
    name: "parse-crlf-separators",
    spec: SPEC,
    input: { op: "parse", block: "iana.a: 1\r\nscheme.bodyHash: a" },
    expected: { error: "invalid-extension-block" },
  },
];

// ─── boundary.json ───────────────────────────────────────────────────────────

const invalidPayloads: Array<[string, Partial<CanonicalPayload>]> = [
  ["method-lowercase", { method: "get" }],
  ["path-without-leading-slash", { path: "api/tx/abc" }],
  ["path-with-dot-segment", { path: "/api/../secret" }],
  ["path-with-duplicate-slashes", { path: "/api//tx" }],
  ["path-with-space", { path: "/api/tx/a b" }],
  ["amount-leading-zeros", { amount: "00.1" }],
  ["amount-scientific-notation", { amount: "1e5" }],
  ["amount-negative", { amount: "-1" }],
  ["amount-nine-decimals", { amount: "0.000000001" }],
  ["payer-without-at", { payer: "v402test.demoAgent" }],
  ["request-id-too-short", { requestId: "01H8XG7Q4M2N8P5R7T3V9WXYZ" }],
  ["request-id-excluded-char", { requestId: "01H8XG7Q4M2N8P5R7T3V9WXYZI" }],
  ["request-id-lowercase", { requestId: "01h8xg7q4m2n8p5r7t3v9wxyza" }],
  ["request-id-first-char-overflow", { requestId: "81H8XG7Q4M2N8P5R7T3V9WXYZA" }],
  ["issued-at-negative", { issuedAt: -1 }],
  ["issued-at-fractional", { issuedAt: 1.5 }],
  ["network-uppercase", { network: "VRSCTEST" }],
  ["scheme-uppercase", { scheme: "Verus-Prepaid-Sig" }],
];

const boundaryCases: TestCase[] = invalidPayloads.map(([name, overrides]) => {
  const payload = { ...getMinimal, ...overrides };
  return {
    name: `canonicalize-rejects-${name}`,
    spec: SPEC,
    input: { op: "canonicalize", payload },
    expected: { error: errorCode(() => canonicalize(payload)) },
  };
});
for (const [name, human, sats] of [
  ["min-amount", "0.00000001", "1"],
  ["one-coin", "1", "100000000"],
  ["trailing-zeros", "1.99999000", "199999000"],
  ["max-uint64", "184467440737.09551616", "18446744073709551616"],
] as const) {
  boundaryCases.push({
    name: `human-to-sats-${name}`,
    spec: SPEC,
    input: { op: "humanToSats", human },
    expected: { sats },
  });
  if (humanToSats(human).toString() !== sats) throw new Error(`sats mismatch for ${human}`);
}
for (const [name, sats, human] of [
  ["zero", "0", "0"],
  ["sub-sat-precision", "123", "0.00000123"],
  ["trims-trailing-zeros", "199999000", "1.99999"],
] as const) {
  boundaryCases.push({
    name: `sats-to-human-${name}`,
    spec: SPEC,
    input: { op: "satsToHuman", sats },
    expected: { human },
  });
  if (satsToHuman(BigInt(sats)) !== human) throw new Error(`human mismatch for ${sats}`);
}

// ─── wire-format.json ────────────────────────────────────────────────────────

const acceptsEntry = {
  scheme: "verus-prepaid-sig",
  schemeVersion: "0.1",
  network: "vrsctest",
  asset: "VRSCTEST",
  amount: "0.001",
  amountUnit: "human",
  payTo: "explorerAPI@",
  facilitator: "https://facilitator.local/v1",
  requiredHeaders: [
    "X-V402-Scheme",
    "X-V402-Payer",
    "X-V402-Amount",
    "X-V402-Request-Id",
    "X-V402-Issued-At",
    "X-V402-Signature",
  ],
  canonicalDomain: "explorer.example.com",
  topup: { depositAddress: "explorerAPI@", attribution: "sender-verusid" },
};

// D1: the normative header form is `<scheme>/<schemeVersion>` (mirrors payload line 1)
const validHeaders = {
  "x-v402-scheme": "verus-prepaid-sig/0.1",
  "x-v402-payer": "v402test.demoAgent@",
  "x-v402-amount": "0.001",
  "x-v402-request-id": "01H8XG7Q4M2N8P5R7T3V9WXYZA",
  "x-v402-issued-at": "1783650000",
  "x-v402-signature": "AgQ2Zml0eXNpZ25hdHVyZQ==",
};

const wireFormatCases: TestCase[] = [
  {
    name: "payment402-normative",
    spec: SPEC,
    input: { type: "payment402", value: { version: "v402/0.1", accepts: [acceptsEntry] } },
    expected: { valid: true },
  },
  {
    name: "payment402-tolerates-unknown-scheme-entry",
    spec: SPEC,
    input: {
      type: "payment402",
      value: {
        version: "v402/0.1",
        accepts: [acceptsEntry, { scheme: "evm-eip3009", schemeVersion: "1.0", someEvmField: true }],
      },
    },
    expected: { valid: true },
  },
  {
    name: "payment402-missing-version",
    spec: SPEC,
    input: { type: "payment402", value: { accepts: [acceptsEntry] } },
    expected: { valid: false },
  },
  {
    name: "requirement-normative",
    spec: SPEC,
    input: { type: "paymentRequirement", value: acceptsEntry },
    expected: { valid: true },
  },
  {
    name: "requirement-keeps-unknown-fields",
    spec: SPEC,
    input: { type: "paymentRequirement", value: { ...acceptsEntry, futureField: "x" } },
    expected: { valid: true },
  },
  {
    name: "requirement-bad-amount-unit",
    spec: SPEC,
    input: { type: "paymentRequirement", value: { ...acceptsEntry, amountUnit: "sats" } },
    expected: { valid: false },
  },
  {
    name: "requirement-empty-required-headers",
    spec: SPEC,
    input: { type: "paymentRequirement", value: { ...acceptsEntry, requiredHeaders: [] } },
    expected: { valid: false },
  },
  {
    name: "discovery-normative",
    spec: SPEC,
    input: {
      type: "discovery",
      value: {
        specUrl: "https://v402.dev/spec/",
        supportedVersions: ["v402/0.1"],
        defaultVersion: "v402/0.1",
        deprecatedVersions: [],
        sunsetDates: {},
        supportedExtensions: ["scheme.bodyHash"],
      },
    },
    expected: { valid: true },
  },
  {
    name: "discovery-missing-supported-versions",
    spec: SPEC,
    input: { type: "discovery", value: { defaultVersion: "v402/0.1" } },
    expected: { valid: false },
  },
  {
    name: "headers-valid",
    spec: SPEC,
    input: { type: "paymentHeaders", value: validHeaders },
    expected: {
      valid: true,
      claim: {
        scheme: "verus-prepaid-sig/0.1",
        payer: "v402test.demoAgent@",
        amount: "0.001",
        requestId: "01H8XG7Q4M2N8P5R7T3V9WXYZA",
        issuedAt: 1783650000,
        signature: "AgQ2Zml0eXNpZ25hdHVyZQ==",
      },
    },
  },
  {
    // D1 compat: a bare scheme name stays parseable — servers treat it as the default version
    name: "headers-bare-scheme-compat",
    spec: SPEC,
    input: { type: "paymentHeaders", value: { ...validHeaders, "x-v402-scheme": "verus-prepaid-sig" } },
    expected: {
      valid: true,
      claim: {
        scheme: "verus-prepaid-sig",
        payer: "v402test.demoAgent@",
        amount: "0.001",
        requestId: "01H8XG7Q4M2N8P5R7T3V9WXYZA",
        issuedAt: 1783650000,
        signature: "AgQ2Zml0eXNpZ25hdHVyZQ==",
      },
    },
  },
  {
    name: "headers-missing-signature",
    spec: SPEC,
    input: { type: "paymentHeaders", value: { ...validHeaders, "x-v402-signature": undefined } },
    expected: { valid: false },
  },
  {
    name: "headers-base64url-signature",
    spec: SPEC,
    input: { type: "paymentHeaders", value: { ...validHeaders, "x-v402-signature": "AgQ2-_l0eXNpZ25hdHVyZQ==" } },
    expected: { valid: false },
  },
  {
    name: "headers-bad-request-id",
    spec: SPEC,
    input: { type: "paymentHeaders", value: { ...validHeaders, "x-v402-request-id": "not-a-ulid" } },
    expected: { valid: false },
  },
];

// ─── signing.json + verification.json (require a Verus testnet node) ─────────

interface RpcConfig {
  url: string;
  user: string;
  pass: string;
}

function rpcConfig(): RpcConfig | undefined {
  const { VERUS_RPC_URL, VERUS_RPC_USER, VERUS_RPC_PASS } = process.env;
  if (!VERUS_RPC_URL || !VERUS_RPC_USER || !VERUS_RPC_PASS) return undefined;
  return { url: VERUS_RPC_URL, user: VERUS_RPC_USER, pass: VERUS_RPC_PASS };
}

async function rpc(config: RpcConfig, method: string, params: unknown[]): Promise<unknown> {
  const response = await fetch(config.url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: "Basic " + Buffer.from(`${config.user}:${config.pass}`).toString("base64"),
    },
    body: JSON.stringify({ jsonrpc: "1.0", id: "v402-vectors", method, params }),
  });
  const body = (await response.json()) as { result?: unknown; error?: { code: number; message: string } };
  if (body.error) throw new Error(`${method} failed: ${body.error.message} (${body.error.code})`);
  return body.result;
}

async function generateSigned(config: RpcConfig): Promise<void> {
  const keys = JSON.parse(readFileSync(join(OUT_DIR, "keys.json"), "utf8")) as {
    keys: Array<{ id: string; wif: string; address: string }>;
    identities: Array<{ name: string }>;
  };
  const keyA = keys.keys.find((k) => k.id === "A")!;
  const keyB = keys.keys.find((k) => k.id === "B")!;
  const identity = keys.identities[0]!.name;

  const info = (await rpc(config, "getinfo", [])) as { VRSCversion: string; name: string };
  if (info.name !== "VRSCTEST") throw new Error(`expected VRSCTEST node, got ${info.name}`);
  for (const key of [keyA, keyB]) {
    const imported = (await rpc(config, "importprivkey", [key.wif, "v402-test-vectors", false])) as string;
    if (imported !== key.address) throw new Error(`key ${key.id}: address mismatch (${imported})`);
  }

  const sign = async (signer: string, message: string): Promise<{ hash: string; signature: string }> => {
    const first = (await rpc(config, "signmessage", [signer, message])) as { hash: string; signature: string };
    const second = (await rpc(config, "signmessage", [signer, message])) as { hash: string; signature: string };
    if (signer.endsWith("@")) return first; // identity sigs embed block height — byte-stable only per snapshot
    if (first.signature !== second.signature) {
      throw new Error(`signmessage not deterministic for ${signer} — do NOT freeze byte-equality vectors`);
    }
    return first;
  };
  const verify = async (signer: string, signature: string, message: string): Promise<boolean> => {
    try {
      return (await rpc(config, "verifymessage", [signer, signature, message])) as boolean;
    } catch {
      return false; // malformed signature encodings error out — the protocol semantic is "reject"
    }
  };

  const canonicalOf = (name: string): string => {
    const found = canonicalCases.find((c) => c.name === name);
    if (!found) throw new Error(`unknown canonical case: ${name}`);
    return found.expected["canonical"] as string;
  };

  const signingDefs = [
    { name: "key-a-get-minimal", signer: keyA.address, wif: keyA.wif, messageRef: "get-minimal" },
    { name: "key-a-post-with-extensions", signer: keyA.address, wif: keyA.wif, messageRef: "post-with-extensions" },
    { name: "key-a-unicode-payer", signer: keyA.address, wif: keyA.wif, messageRef: "unicode-payer" },
    { name: "key-a-balance-query", signer: keyA.address, wif: keyA.wif, messageRef: "balance-query" },
    { name: "key-b-get-minimal", signer: keyB.address, wif: keyB.wif, messageRef: "get-minimal" },
    { name: "identity-get-minimal", signer: identity, wif: null, messageRef: "get-minimal" },
  ];

  const signingCases: TestCase[] = [];
  for (const def of signingDefs) {
    const message = canonicalOf(def.messageRef);
    const { hash, signature } = await sign(def.signer, message);
    signingCases.push({
      name: def.name,
      spec: SPEC,
      input: { signer: def.signer, wif: def.wif, messageRef: def.messageRef, message },
      expected: {
        signature,
        hash,
        assert: def.wif === null ? "verify-only" : "signature-equal",
      },
    });
  }
  writeVectors("signing.json", "signing", signingCases, {
    network: "vrsctest",
    daemon: info.VRSCversion,
    note: "assert=signature-equal cases are byte-reproducible from the WIF (signmessage is deterministic). assert=verify-only cases (VerusID) embed the signing block height; validate them via verifymessage instead of byte comparison.",
  });

  const sigOf = (name: string): { message: string; signature: string; signer: string } => {
    const found = signingCases.find((c) => c.name === name)!;
    return {
      message: found.input["message"] as string,
      signature: found.expected["signature"] as string,
      signer: found.input["signer"] as string,
    };
  };
  const keyASig = sigOf("key-a-get-minimal");
  const keyBSig = sigOf("key-b-get-minimal");
  const identitySig = sigOf("identity-get-minimal");
  const tamperedMessage = keyASig.message.replace("amount: 0.001", "amount: 0.002");

  const verificationDefs = [
    {
      name: "accept-valid-address-signature",
      signer: keyASig.signer,
      signature: keyASig.signature,
      message: keyASig.message,
      accept: true,
      reason: null as string | null,
    },
    {
      name: "accept-valid-identity-signature",
      signer: identitySig.signer,
      signature: identitySig.signature,
      message: identitySig.message,
      accept: true,
      reason: null,
    },
    {
      name: "reject-tampered-message",
      signer: keyASig.signer,
      signature: keyASig.signature,
      message: tamperedMessage,
      accept: false,
      reason: "signature-mismatch",
    },
    {
      name: "reject-wrong-signer",
      signer: keyASig.signer,
      signature: keyBSig.signature,
      message: keyASig.message,
      accept: false,
      reason: "signature-mismatch",
    },
    {
      name: "reject-malformed-base64",
      signer: keyASig.signer,
      signature: "not-base64!",
      message: keyASig.message,
      accept: false,
      reason: "malformed-signature-encoding",
    },
  ];

  const verificationCases: TestCase[] = [];
  for (const def of verificationDefs) {
    const observed = await verify(def.signer, def.signature, def.message);
    if (observed !== def.accept) {
      throw new Error(`verification case ${def.name}: node says ${observed}, expected ${def.accept}`);
    }
    verificationCases.push({
      name: def.name,
      spec: SPEC,
      input: { signer: def.signer, signature: def.signature, message: def.message },
      expected: def.reason === null ? { accept: def.accept } : { accept: def.accept, reason: def.reason },
    });
  }
  writeVectors("verification.json", "verification", verificationCases, {
    network: "vrsctest",
    daemon: info.VRSCversion,
    note: "Every case was confirmed against verusd verifymessage at generation time. `reason` is informative — implementations must match `accept`.",
  });
}

// ─── main ────────────────────────────────────────────────────────────────────

writeVectors("canonical.json", "canonical", canonicalCases);
writeVectors("extensions.json", "extensions", extensionsCases);
writeVectors("boundary.json", "boundary", boundaryCases);
writeVectors("wire-format.json", "wire-format", wireFormatCases);

const config = rpcConfig();
if (config) {
  await generateSigned(config);
} else {
  console.log("VERUS_RPC_URL/USER/PASS not set — skipping signing.json + verification.json (existing files kept)");
}
