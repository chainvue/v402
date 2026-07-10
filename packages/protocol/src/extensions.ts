import { V402ProtocolError } from "./errors.js";
import type { ExtensionField } from "./types.js";

/** Normative decoded size limit of the `X-V402-Extensions` block (B2). Enforced by servers. */
export const MAX_EXTENSIONS_BYTES = 4096;

/**
 * Extension key grammar: `<prefix>.<field>` where prefix is `scheme`, `iana`,
 * or vendor-custom `x-<vendor>`. Field names are single alphanumeric segments
 * starting with a letter (camelCase by convention, e.g. `scheme.bodyHash`).
 */
const EXTENSION_KEY_RE = /^(?:scheme|iana|x-[a-z0-9]+(?:-[a-z0-9]+)*)\.[A-Za-z][A-Za-z0-9]*$/;

export function isValidExtensionKey(key: string): boolean {
  return EXTENSION_KEY_RE.test(key);
}

function assertValidField(field: ExtensionField): void {
  if (!EXTENSION_KEY_RE.test(field.key)) {
    throw new V402ProtocolError("invalid-extension-key", `invalid extension key: ${JSON.stringify(field.key)}`);
  }
  if (field.value.length === 0 || /[\r\n]/.test(field.value) || field.value.startsWith(" ")) {
    throw new V402ProtocolError(
      "invalid-extension-value",
      `extension value for ${field.key} must be non-empty, single-line, and must not start with a space`,
    );
  }
}

/**
 * Serialize extension fields to the exact byte block that gets signed and
 * transmitted (base64-encoded) in `X-V402-Extensions`: `key: value` lines,
 * sorted bytewise-ascending by key, LF-separated, no trailing newline.
 *
 * Input order does not matter — sorting happens here so all parties produce
 * identical bytes. Duplicate keys are rejected.
 */
export function serializeExtensionBlock(fields: ExtensionField[]): string {
  const seen = new Set<string>();
  for (const field of fields) {
    assertValidField(field);
    if (seen.has(field.key)) {
      throw new V402ProtocolError("extensions-duplicate-key", `duplicate extension key: ${field.key}`);
    }
    seen.add(field.key);
  }
  return fields
    .slice()
    .sort((a, b) => (a.key < b.key ? -1 : 1))
    .map((f) => `${f.key}: ${f.value}`)
    .join("\n");
}

/**
 * Parse + validate a decoded `X-V402-Extensions` block (server side).
 * The block must already be byte-identical to what was signed: LF-separated
 * `key: value` lines, strictly ascending key order, no trailing newline.
 * Semantic validation of known `scheme.*` fields is the verifier's job.
 */
export function parseExtensionBlock(block: string): ExtensionField[] {
  if (block.length === 0) return [];
  if (/\r/.test(block) || block.endsWith("\n")) {
    throw new V402ProtocolError("invalid-extension-block", "extension block must be LF-separated without trailing newline");
  }
  const fields: ExtensionField[] = [];
  let previousKey: string | undefined;
  for (const line of block.split("\n")) {
    const separator = line.indexOf(": ");
    if (separator <= 0) {
      throw new V402ProtocolError("invalid-extension-block", `malformed extension line: ${JSON.stringify(line)}`);
    }
    const field: ExtensionField = { key: line.slice(0, separator), value: line.slice(separator + 2) };
    assertValidField(field);
    if (previousKey !== undefined && !(previousKey < field.key)) {
      const code = previousKey === field.key ? "extensions-duplicate-key" : "extensions-unsorted";
      throw new V402ProtocolError(code, `extension keys must be strictly ascending: ${previousKey} → ${field.key}`);
    }
    previousKey = field.key;
    fields.push(field);
  }
  return fields;
}
