// Subprocess-protocol fixture: serves the REFERENCE implementation over the
// NDJSON wire format (see src/subprocess.ts). Used by the test suite to
// prove the transport end-to-end — self-conformance through a real process
// boundary. OPS env (comma-separated) restricts the declared ops to test
// partial-implementation skip behavior.
//
// Imports the built package output (dist/) directly: a package cannot
// resolve itself by name, and the workspace convention is that tests run
// against built packages anyway.
import { createInterface } from "node:readline";
import { referenceTarget } from "../../dist/index.js";

const target = referenceTarget();
const allOps = [
  "canonicalize",
  "serializeExtensions",
  "parseExtensions",
  "humanToSats",
  "satsToHuman",
  "validateWireFormat",
  "messageHash",
  "signMessage",
  "verifyMessage",
];
const ops = process.env.OPS ? process.env.OPS.split(",") : allOps;

const reply = (value) => process.stdout.write(JSON.stringify(value) + "\n");

async function dispatch(op, args) {
  switch (op) {
    case "hello":
      return { name: "reference-child", ops };
    case "canonicalize":
      return target.canonicalize(args.payload, args.payloadType);
    case "serializeExtensions":
      return target.serializeExtensions(args.fields);
    case "parseExtensions":
      return target.parseExtensions(args.block);
    case "humanToSats":
      return target.humanToSats(args.human);
    case "satsToHuman":
      return target.satsToHuman(args.sats);
    case "validateWireFormat":
      return target.validateWireFormat(args.type, args.value);
    case "messageHash":
      return target.messageHash(args.message);
    case "signMessage":
      return target.signMessage(args.message, args.wif);
    case "verifyMessage":
      return target.verifyMessage(args.message, args.signature, args.signer, args.identity);
    default:
      throw new Error(`unknown op ${op}`);
  }
}

const lines = createInterface({ input: process.stdin });
lines.on("line", (line) => {
  if (line.trim() === "") return;
  const request = JSON.parse(line);
  Promise.resolve()
    .then(() => dispatch(request.op, request.args ?? {}))
    .then((result) => reply({ id: request.id, ok: true, result }))
    .catch((err) =>
      reply({
        id: request.id,
        ok: false,
        error: { ...(err.code !== undefined ? { code: err.code } : {}), message: err.message },
      }),
    );
});
