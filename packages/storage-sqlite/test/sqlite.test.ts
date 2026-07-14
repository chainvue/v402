import { execFile } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterAll, describe, expect, it } from "vitest";
import { describeStorageContract } from "../../storage/test/storage-contract.js";
import { SqliteStorage } from "../src/index.js";

const execFileAsync = promisify(execFile);

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

  it("BEGIN IMMEDIATE serializes TRUE cross-process writers: no double-spend", async () => {
    // Two separate OS processes hammer the same DB file with reserves for the
    // same identity. Combined they attempt 20 × 10k against a 50k balance —
    // whatever the interleaving, exactly 5 may win. This exercises the real
    // SQLite write lock across connections, not the in-process fallback.
    const path = join(dir, "xproc.sqlite");
    const seed = freshStorage(path);
    await seed.initialize();
    await fund(seed, "agent@", 50_000n);
    await seed.close();

    const distUrl = new URL("../dist/index.js", import.meta.url).href;
    const script = join(dir, "xproc-writer.mjs");
    writeFileSync(
      script,
      `
      const [, , dbPath, prefix] = process.argv;
      const { SqliteStorage } = await import(${JSON.stringify(distUrl)});
      const storage = new SqliteStorage({ path: dbPath });
      await storage.initialize();
      const results = [];
      for (let i = 0; i < 10; i++) {
        const r = await storage.reservePayment({
          requestId: prefix + String(i).padStart(2, "0"),
          identityId: "agent@",
          issuedAt: 1783650000,
          receivedAt: 1783650000,
          amountSats: 10000n,
          method: "GET",
          path: "/x",
        });
        results.push(r.status);
      }
      await storage.close();
      process.stdout.write(JSON.stringify(results));
      `,
    );

    const [a, b] = await Promise.all([
      execFileAsync(process.execPath, [script, path, "01XA"], { timeout: 30_000 }),
      execFileAsync(process.execPath, [script, path, "01XB"], { timeout: 30_000 }),
    ]);
    const statuses = [...(JSON.parse(a.stdout) as string[]), ...(JSON.parse(b.stdout) as string[])];
    expect(statuses).toHaveLength(20);
    expect(statuses.filter((s) => s === "reserved")).toHaveLength(5);
    expect(statuses.filter((s) => s === "insufficient")).toHaveLength(15);

    const check = freshStorage(path);
    await check.initialize();
    expect((await check.getIdentity("agent@"))?.balanceSats).toBe(0n);
    const summary = await check.getLedgerSummary("agent@");
    expect(summary.sumSats).toBe(0n);
    expect(summary.latestBalanceAfterSats).toBe(0n);
  }, 60_000);

  it("a throw mid-transaction rolls back balance, ledger AND replay row together", async () => {
    const path = join(dir, "partial-failure.sqlite");
    const storage = freshStorage(path);
    await storage.initialize();
    await fund(storage, "agent@", 100_000n);

    // Inject a crash between the balance update and the ledger append.
    const boom = new Error("injected mid-transaction failure");
    const patchable = storage as unknown as { appendLedger: (...args: unknown[]) => void };
    const original = patchable.appendLedger;
    patchable.appendLedger = () => {
      throw boom;
    };
    try {
      await expect(
        storage.reservePayment({
          requestId: "01CRASH",
          identityId: "agent@",
          issuedAt: T0,
          receivedAt: T0,
          amountSats: 40_000n,
          method: "GET",
          path: "/x",
        }),
      ).rejects.toThrow("injected mid-transaction failure");
    } finally {
      patchable.appendLedger = original;
    }

    // nothing half-applied: no debit, no ledger row, requestId NOT burned
    expect((await storage.getIdentity("agent@"))?.balanceSats).toBe(100_000n);
    expect(await storage.getSpentRequest("01CRASH")).toBeUndefined();
    const summary = await storage.getLedgerSummary("agent@");
    expect(summary.entryCount).toBe(1); // only the funding deposit
    expect(summary.latestBalanceAfterSats).toBe(100_000n);
    // the storage still works after the injected failure
    expect((await storage.reservePayment({
      requestId: "01AFTER",
      identityId: "agent@",
      issuedAt: T0,
      receivedAt: T0,
      amountSats: 40_000n,
      method: "GET",
      path: "/x",
    })).status).toBe("reserved");
  });

  it("solvency invariant trips on externally corrupted balance and rolls back", async () => {
    const path = join(dir, "corrupt.sqlite");
    const storage = freshStorage(path);
    await storage.initialize();
    await fund(storage, "agent@", 50_000n);

    // Corrupt the balance behind the ledger's back (simulates a buggy write
    // path or direct DB manipulation).
    const Database = (await import("better-sqlite3")).default;
    const raw = new Database(path);
    raw.prepare("UPDATE identities SET balance = '999999' WHERE identity_id = 'agent@'").run();
    raw.close();

    await expect(
      storage.reservePayment({
        requestId: "01CORRUPT",
        identityId: "agent@",
        issuedAt: T0,
        receivedAt: T0,
        amountSats: 10_000n,
        method: "GET",
        path: "/x",
      }),
    ).rejects.toThrow(/solvency invariant violated/);
    // the failed mutation burned nothing
    expect(await storage.getSpentRequest("01CORRUPT")).toBeUndefined();
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
