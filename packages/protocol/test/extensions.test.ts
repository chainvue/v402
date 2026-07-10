import { describe, expect, it } from "vitest";
import {
  V402ProtocolError,
  isValidExtensionKey,
  parseExtensionBlock,
  serializeExtensionBlock,
} from "../src/index.js";

function errorCode(fn: () => unknown): string {
  try {
    fn();
  } catch (err) {
    if (err instanceof V402ProtocolError) return err.code;
    throw err;
  }
  throw new Error("expected V402ProtocolError, nothing was thrown");
}

describe("serializeExtensionBlock", () => {
  it("sorts keys bytewise ascending regardless of input order", () => {
    expect(
      serializeExtensionBlock([
        { key: "x-mystartup.orderId", value: "ord_12345" },
        { key: "iana.something", value: "x" },
        { key: "scheme.bodyHash", value: "sha256:abc" },
      ]),
    ).toBe("iana.something: x\nscheme.bodyHash: sha256:abc\nx-mystartup.orderId: ord_12345");
  });

  it("rejects duplicate keys", () => {
    expect(
      errorCode(() =>
        serializeExtensionBlock([
          { key: "scheme.bodyHash", value: "a" },
          { key: "scheme.bodyHash", value: "b" },
        ]),
      ),
    ).toBe("extensions-duplicate-key");
  });

  it.each([
    ["missing prefix", "bodyHash"],
    ["unknown prefix", "foo.bar"],
    ["uppercase vendor", "x-MyStartup.orderId"],
    ["field starting with digit", "scheme.1abc"],
    ["nested field segments", "scheme.body.hash"],
    ["bare x prefix", "x-.field"],
  ])("rejects invalid key (%s)", (_name, key) => {
    expect(isValidExtensionKey(key)).toBe(false);
    expect(errorCode(() => serializeExtensionBlock([{ key, value: "v" }]))).toBe("invalid-extension-key");
  });

  it.each([
    ["empty value", ""],
    ["value with newline", "a\nb"],
    ["value with CR", "a\rb"],
    ["value with leading space", " a"],
  ])("rejects invalid value (%s)", (_name, value) => {
    expect(errorCode(() => serializeExtensionBlock([{ key: "scheme.bodyHash", value }]))).toBe(
      "invalid-extension-value",
    );
  });
});

describe("parseExtensionBlock", () => {
  it("round-trips serializeExtensionBlock output", () => {
    const fields = [
      { key: "scheme.bodyHash", value: "sha256:abc" },
      { key: "x-mystartup.orderId", value: "ord_12345" },
    ];
    expect(parseExtensionBlock(serializeExtensionBlock(fields))).toEqual(fields);
  });

  it("returns [] for an empty block (header absent = no extension section)", () => {
    expect(parseExtensionBlock("")).toEqual([]);
  });

  it("preserves colons and spaces inside values", () => {
    expect(parseExtensionBlock("scheme.bodyHash: sha256:a: b")).toEqual([
      { key: "scheme.bodyHash", value: "sha256:a: b" },
    ]);
  });

  it("rejects unsorted blocks", () => {
    expect(errorCode(() => parseExtensionBlock("x-a.b: 1\nscheme.bodyHash: a"))).toBe("extensions-unsorted");
  });

  it("rejects duplicate keys", () => {
    expect(errorCode(() => parseExtensionBlock("scheme.bodyHash: a\nscheme.bodyHash: b"))).toBe(
      "extensions-duplicate-key",
    );
  });

  it.each([
    ["trailing newline", "scheme.bodyHash: a\n"],
    ["CRLF separators", "iana.a: 1\r\nscheme.bodyHash: a"],
    ["line without separator", "scheme.bodyHash"],
    ["line with colon but no space", "scheme.bodyHash:a"],
  ])("rejects malformed block (%s)", (_name, block) => {
    expect(errorCode(() => parseExtensionBlock(block))).toBe("invalid-extension-block");
  });
});
