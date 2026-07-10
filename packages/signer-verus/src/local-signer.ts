import { readFileSync, statSync } from "node:fs";
import { signAddressMessage, signIdentityMessage } from "./sign.js";
import { decodeWif } from "./wif.js";
import type { HeightProvider, Signer } from "./types.js";

export interface LocalSignerIdentity {
  /** The signing identity's i-address, e.g. iGnQaDzEcrFWg3J9Jg5MqPKCwo52Din4Ma for v402test@. */
  identityAddress: string;
  /** Chain/system i-address the signature is bound to, e.g. iJhCezBExJHvtyH3fGhNnt2NhU4Ztkf2yq for VRSCTEST. */
  systemId: string;
}

export interface LocalSignerOptions {
  /**
   * Sign as a VerusID (identity-signature format, requires heightProvider).
   * Identity digests bind the chain and the identity's i-address, so both
   * are required — resolve them once via `getidentity` (identityaddress,
   * systemid) or the facilitator discovery. Without this option the signer
   * produces plain address signatures — verifiable against the key's
   * R-address only, NOT against an identity name.
   */
  identity?: LocalSignerIdentity;
  /** Recent-block source for identity signatures (facilitator health, getblockcount, …). */
  heightProvider?: HeightProvider;
}

/** Shared WIF-based signing core of EnvSigner and FileSigner. */
export class LocalKeySigner implements Signer {
  private readonly privateKey: Uint8Array;
  private readonly options: LocalSignerOptions;

  constructor(wif: string, options: LocalSignerOptions = {}) {
    if (options.identity !== undefined && options.heightProvider === undefined) {
      throw new Error(
        "identity signatures embed the signing block height — provide heightProvider (e.g. from the facilitator health endpoint)",
      );
    }
    this.privateKey = decodeWif(wif);
    this.options = options;
  }

  async signMessage(message: string): Promise<string> {
    if (this.options.identity !== undefined) {
      const blockHeight = await this.options.heightProvider!();
      return signIdentityMessage(message, this.privateKey, { blockHeight, ...this.options.identity });
    }
    return signAddressMessage(message, this.privateKey);
  }
}

export interface EnvSignerOptions extends LocalSignerOptions {
  /** Env var holding the WIF. Default VERUS_SIGNING_KEY. */
  envVar?: string;
  /** Injectable for tests; defaults to process.env. */
  env?: NodeJS.ProcessEnv;
}

/**
 * Headless deployments without a node (plan): WIF from the environment,
 * 12-factor/secret-manager friendly. Never log the value.
 */
export class EnvSigner extends LocalKeySigner {
  constructor(options: EnvSignerOptions = {}) {
    const envVar = options.envVar ?? "VERUS_SIGNING_KEY";
    const wif = (options.env ?? process.env)[envVar];
    if (wif === undefined || wif === "") {
      throw new Error(`EnvSigner: ${envVar} is not set`);
    }
    super(wif, options);
  }
}

export interface FileSignerOptions extends LocalSignerOptions {
  /** Path to the WIF key file, e.g. ~/.v402/keys/<identity>.key */
  path: string;
}

/**
 * Unix-style local dev (plan): WIF from a key file. Refuses group/world-
 * accessible files (mode must be 0600 or stricter).
 */
export class FileSigner extends LocalKeySigner {
  constructor(options: FileSignerOptions) {
    const mode = statSync(options.path).mode & 0o777;
    if ((mode & 0o077) !== 0) {
      throw new Error(
        `FileSigner: ${options.path} is accessible by group/others (mode ${mode.toString(8)}) — chmod 600 it`,
      );
    }
    super(readFileSync(options.path, "utf8").trim(), options);
  }
}
