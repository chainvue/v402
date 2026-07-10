import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { describeStorageContract } from "../../storage/test/storage-contract.js";
import { SqliteStorage } from "../src/index.js";

const dir = mkdtempSync(join(tmpdir(), "v402-sqlite-"));
let fileCounter = 0;
const openStorages: SqliteStorage[] = [];

function freshStorage(path = join(dir, `db-${fileCounter++}.sqlite`)): SqliteStorage {
  const storage = new SqliteStorage({ path });
  openStorages.push(storage);
  return storage;
}

afterAll(async () => {
  for (const storage of openStorages) await storage.close();
  rmSync(dir, { recursive: true, force: true });
});

// The full behavioral contract — identical suite to InMemoryStorage.
describeStorageContract("SqliteStorage (temp files)", async () => freshStorage());

describe("SqliteStorage specifics", () => {
  const T0 = 1_783_650_000;

  async function fund(storage: SqliteStorage, identityId: string, sats: bigint): Promise<void> {
    const deposit = await storage.insertDeposit({
      identityId,
      amountSats: sats,
      currency: "VRSCTEST",
      txid: `tx-${identityId}`,
      vout: 0,
      blockHeight: 100,
      blockHash: "h100",
      confirmations: 10,
      detectedAt: T0,
      origin: "real",
    });
    await storage.creditDeposit(deposit.id, T0);
  }

  it("enables WAL journal mode by default", async () => {
    const path = join(dir, "wal-check.sqlite");
    const storage = freshStorage(path);
    await storage.initialize();
    // second connection observes the persistent WAL mode
    const probe = new SqliteStorage({ path });
    openStorages.push(probe);
    await probe.initialize();
    expect(await probe.getIdentity("nobody@")).toBeUndefined(); // connection works
    const Database = (await import("better-sqlite3")).default;
    const raw = new Database(path, { readonly: true });
    expect(raw.pragma("journal_mode", { simple: true })).toBe("wal");
    raw.close();
  });

  it("persists across close/reopen", async () => {
    const path = join(dir, "persist.sqlite");
    const first = new SqliteStorage({ path });
    await first.initialize();
    await fund(first, "agent@", 100_000n);
    await first.reservePayment({
      requestId: "01PERSIST",
      identityId: "agent@",
      issuedAt: T0,
      receivedAt: T0,
      amountSats: 40_000n,
      method: "GET",
      path: "/x",
    });
    await first.close();

    const second = freshStorage(path);
    await second.initialize();
    expect((await second.getIdentity("agent@"))?.balanceSats).toBe(60_000n);
    expect((await second.getSpentRequest("01PERSIST"))?.status).toBe("reserved");
    const summary = await second.getLedgerSummary("agent@");
    expect(summary.latestBalanceAfterSats).toBe(60_000n);
  });

  it("reports replay when a second connection races the same requestId", async () => {
    const path = join(dir, "race.sqlite");
    const a = freshStorage(path);
    const b = freshStorage(path);
    await a.initialize();
    await b.initialize();
    await fund(a, "agent@", 100_000n);

    const input = {
      requestId: "01RACE",
      identityId: "agent@",
      issuedAt: T0,
      receivedAt: T0,
      amountSats: 10_000n,
      method: "GET",
      path: "/x",
    };
    expect((await a.reservePayment(input)).status).toBe("reserved");
    // second connection sees the committed row of the first writer
    expect(await b.reservePayment(input)).toEqual({ status: "replay", previousStatus: "reserved" });
    expect((await b.getIdentity("agent@"))?.balanceSats).toBe(90_000n); // debited exactly once
  });

  it("initialize is idempotent and migrations re-run safely", async () => {
    const path = join(dir, "idempotent.sqlite");
    const storage = freshStorage(path);
    await storage.initialize();
    await storage.initialize();
    await fund(storage, "agent@", 1n);
    await storage.close();
    const again = freshStorage(path);
    await again.initialize(); // migrate() on an already-migrated file must be a no-op
    expect((await again.getIdentity("agent@"))?.balanceSats).toBe(1n);
  });
});
