import { normalizeIdentityKey } from "@chainvue/v402-protocol";
import type { IVerusRpc, VerusRawTransaction } from "@chainvue/v402-verus-rpc";
import type { UnattributedReason } from "./types.js";

export type AttributionResult =
  | { ok: true; identityKey: string; identityAddress: string }
  | { ok: false; reason: UnattributedReason };

/**
 * Strip the native chain suffix from a fully qualified identity name:
 * "foo1.fum.VRSCTEST@" → "foo1.fum@". Clients sign with the chain-relative
 * name, so balance keys must use the same form.
 */
export function stripChainSuffix(fullyQualifiedName: string, chainName: string): string {
  const suffix = `.${chainName.toLowerCase()}@`;
  const lower = fullyQualifiedName.toLowerCase();
  if (lower.endsWith(suffix)) {
    return fullyQualifiedName.slice(0, fullyQualifiedName.length - suffix.length) + "@";
  }
  return fullyQualifiedName;
}

/** Caches per poll cycle — the same sender usually appears in many vins. */
export interface AttributionCaches {
  /** source txid → transaction (vin lookups). */
  sourceTxs: Map<string, VerusRawTransaction>;
  /** i-address → normalized identity key. */
  identityKeys: Map<string, string>;
}

export function emptyAttributionCaches(): AttributionCaches {
  return { sourceTxs: new Map(), identityKeys: new Map() };
}

/**
 * Sender-VerusID attribution (plan § Attribution rules):
 * - collect the source addresses of all vins (via `vin.address(es)` when the
 *   daemon provides them, else by fetching the source tx's vout);
 * - identity vins = i-addresses; ALL identity vins must resolve to the same
 *   identity, otherwise no auto-credit;
 * - no identity vin at all (plain t-addresses, coinbase) → no auto-credit.
 * Unattributed outputs land on the manual-reconciliation list.
 */
export async function attributeSender(
  tx: VerusRawTransaction,
  rpc: IVerusRpc,
  chainName: string,
  caches: AttributionCaches,
): Promise<AttributionResult> {
  const sourceAddresses = new Set<string>();
  for (const vin of tx.vin) {
    if (vin.coinbase !== undefined) continue;
    if (typeof vin.address === "string") {
      sourceAddresses.add(vin.address);
      continue;
    }
    if (Array.isArray(vin.addresses)) {
      for (const address of vin.addresses) sourceAddresses.add(address);
      continue;
    }
    if (vin.txid === undefined || vin.vout === undefined) continue;
    let source = caches.sourceTxs.get(vin.txid);
    if (!source) {
      source = await rpc.getRawTransaction(vin.txid);
      caches.sourceTxs.set(vin.txid, source);
    }
    for (const address of source.vout[vin.vout]?.scriptPubKey.addresses ?? []) {
      sourceAddresses.add(address);
    }
  }

  const identityAddresses = [...sourceAddresses].filter((a) => a.startsWith("i"));
  if (identityAddresses.length === 0) return { ok: false, reason: "no-identity-vin" };
  if (new Set(identityAddresses).size > 1) return { ok: false, reason: "multiple-identities" };

  const identityAddress = identityAddresses[0]!;
  let identityKey = caches.identityKeys.get(identityAddress);
  if (identityKey === undefined) {
    const result = await rpc.getIdentity(identityAddress);
    const friendly =
      result.fullyqualifiedname !== undefined
        ? stripChainSuffix(result.fullyqualifiedname, chainName)
        : `${result.identity.name}@`;
    identityKey = normalizeIdentityKey(friendly);
    caches.identityKeys.set(identityAddress, identityKey);
  }
  return { ok: true, identityKey, identityAddress };
}
