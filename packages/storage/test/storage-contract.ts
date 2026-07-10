import { beforeEach, describe, expect, it } from "vitest";
import type { IStorage } from "../src/index.js";

/**
 * Behavioral contract every IStorage implementation must satisfy.
 * `@chainvue/v402-storage-sqlite` runs this same suite against real SQLite
 * files — semantics diverging between backends is a bug by definition.
 */
export function describeStorageContract(name: string, factory: () => Promise<IStorage>): void {
  describe(`IStorage contract: ${name}`, () => {
    let storage: IStorage;
    const T0 = 1_783_650_000;

    beforeEach(async () => {
      storage = await factory();
      await storage.initialize();
    });

    /** Seed an identity with a credited deposit of `sats`. */
    async function fund(identityId: string, sats: bigint, txid = `tx-${identityId}`): Promise<void> {
      const deposit = await storage.insertDeposit({
        identityId,
        amountSats: sats,
        currency: "VRSCTEST",
        txid,
        vout: 0,
        blockHeight: 100,
        blockHash: "hash-100",
        confirmations: 10,
        detectedAt: T0,
        origin: "real",
      });
      const credited = await storage.creditDeposit(deposit.id, T0);
      expect(credited.ok).toBe(true);
    }

    async function expectLedgerInvariants(identityId: string): Promise<void> {
      const identity = await storage.getIdentity(identityId);
      const summary = await storage.getLedgerSummary(identityId);
      expect(identity).toBeDefined();
      expect(summary.sumSats).toBe(identity!.balanceSats);
      expect(summary.latestBalanceAfterSats).toBe(identity!.balanceSats);
    }

    const reserveInput = (requestId: string, identityId: string, amountSats: bigint) => ({
      requestId,
      identityId,
      issuedAt: T0,
      receivedAt: T0 + 1,
      amountSats,
      method: "GET",
      path: "/api/tx/abc",
    });

    describe("two-phase debit", () => {
      it("reserve → commit decrements once and keeps the ledger consistent", async () => {
        await fund("agent@", 100_000n);
        const reserved = await storage.reservePayment(reserveInput("01A", "agent@", 30_000n));
        expect(reserved).toEqual({ status: "reserved", balanceAfterSats: 70_000n });

        const committed = await storage.commitPayment("01A", 1234, T0 + 2);
        expect(committed).toEqual({ ok: true });
        expect((await storage.getSpentRequest("01A"))?.status).toBe("committed");
        expect((await storage.getSpentRequest("01A"))?.responseBytes).toBe(1234);
        expect((await storage.getIdentity("agent@"))?.balanceSats).toBe(70_000n);
        expect((await storage.getIdentity("agent@"))?.lastRequestAt).toBe(T0 + 1);
        await expectLedgerInvariants("agent@");
      });

      it("replayed requestId reports the previous status", async () => {
        await fund("agent@", 100_000n);
        await storage.reservePayment(reserveInput("01A", "agent@", 30_000n));
        expect(await storage.reservePayment(reserveInput("01A", "agent@", 30_000n))).toEqual({
          status: "replay",
          previousStatus: "reserved",
        });
        await storage.commitPayment("01A", 10, T0 + 2);
        expect(await storage.reservePayment(reserveInput("01A", "agent@", 30_000n))).toEqual({
          status: "replay",
          previousStatus: "committed",
        });
      });

      it("rollback refunds exactly once (strictly conditional, B3)", async () => {
        await fund("agent@", 100_000n);
        await storage.reservePayment(reserveInput("01A", "agent@", 30_000n));
        expect(await storage.rollbackPayment("01A", T0 + 2)).toEqual({ ok: true });
        expect((await storage.getIdentity("agent@"))?.balanceSats).toBe(100_000n);
        expect((await storage.getSpentRequest("01A"))?.status).toBe("error");
        // second rollback must be a no-op conflict, not a double refund
        expect(await storage.rollbackPayment("01A", T0 + 3)).toEqual({ ok: false, currentStatus: "error" });
        expect((await storage.getIdentity("agent@"))?.balanceSats).toBe(100_000n);
        await expectLedgerInvariants("agent@");
      });

      it("insufficient balance burns the requestId without moving money", async () => {
        await fund("agent@", 10_000n);
        expect(await storage.reservePayment(reserveInput("01A", "agent@", 30_000n))).toEqual({
          status: "insufficient",
          balanceSats: 10_000n,
        });
        expect((await storage.getSpentRequest("01A"))?.status).toBe("insufficient");
        expect(await storage.reservePayment(reserveInput("01A", "agent@", 30_000n))).toEqual({
          status: "replay",
          previousStatus: "insufficient",
        });
        expect((await storage.getIdentity("agent@"))?.balanceSats).toBe(10_000n);
        await expectLedgerInvariants("agent@");
      });

      it("unknown identity burns the requestId and does not auto-provision", async () => {
        expect(await storage.reservePayment(reserveInput("01A", "ghost@", 1n))).toEqual({
          status: "unknown-identity",
        });
        expect(await storage.getIdentity("ghost@")).toBeUndefined();
        expect((await storage.getSpentRequest("01A"))?.status).toBe("insufficient");
      });

      it("commit/rollback of an unknown requestId reports currentStatus undefined", async () => {
        expect(await storage.commitPayment("nope", 0, T0)).toEqual({ ok: false, currentStatus: undefined });
        expect(await storage.rollbackPayment("nope", T0)).toEqual({ ok: false, currentStatus: undefined });
      });
    });

    describe("reaper + late commit (B3)", () => {
      it("reaps only expired reserved rows and refunds them", async () => {
        await fund("agent@", 100_000n);
        await storage.reservePayment(reserveInput("01OLD", "agent@", 30_000n));
        await storage.reservePayment({ ...reserveInput("01NEW", "agent@", 20_000n), receivedAt: T0 + 500 });
        const reaped = await storage.reapExpiredReservations(T0 + 400, T0 + 700);
        expect(reaped).toEqual(["01OLD"]);
        expect((await storage.getSpentRequest("01OLD"))?.status).toBe("error");
        expect((await storage.getSpentRequest("01NEW"))?.status).toBe("reserved");
        expect((await storage.getIdentity("agent@"))?.balanceSats).toBe(80_000n); // 100k − 20k still reserved
        await expectLedgerInvariants("agent@");
      });

      it("late commit after reap re-debits deterministically, balance may go negative", async () => {
        await fund("agent@", 100_000n);
        await storage.reservePayment(reserveInput("01A", "agent@", 100_000n));
        await storage.reapExpiredReservations(T0 + 999, T0 + 999); // refund → balance 100k
        await storage.reservePayment({ ...reserveInput("01B", "agent@", 100_000n), receivedAt: T0 + 1000 });
        await storage.commitPayment("01B", 10, T0 + 1001); // balance 0

        // the slow 2xx of 01A finally lands: commit conflicts, late commit re-debits
        expect(await storage.commitPayment("01A", 55, T0 + 1002)).toEqual({ ok: false, currentStatus: "error" });
        const late = await storage.lateCommitPayment("01A", 55, T0 + 1002);
        expect(late).toEqual({ ok: true, balanceAfterSats: -100_000n });
        expect((await storage.getSpentRequest("01A"))?.status).toBe("committed");
        await expectLedgerInvariants("agent@");
      });

      it("late commit is only valid from status error", async () => {
        await fund("agent@", 100_000n);
        await storage.reservePayment(reserveInput("01A", "agent@", 1n));
        expect(await storage.lateCommitPayment("01A", 0, T0)).toEqual({ ok: false, currentStatus: "reserved" });
      });
    });

    describe("replay retention", () => {
      it("cleanup removes only rows older than the cutoff", async () => {
        await fund("agent@", 100_000n);
        await storage.reservePayment({ ...reserveInput("01OLD", "agent@", 1n), issuedAt: T0 - 700 });
        await storage.reservePayment(reserveInput("01NEW", "agent@", 1n));
        expect(await storage.cleanupSpentRequests(T0 - 600)).toBe(1);
        expect(await storage.getSpentRequest("01OLD")).toBeUndefined();
        expect(await storage.getSpentRequest("01NEW")).toBeDefined();
      });

      it("balance queries are replay-protected zero-amount committed rows", async () => {
        const input = {
          requestId: "01BQ",
          identityId: "agent@",
          issuedAt: T0,
          receivedAt: T0,
          method: "GET",
          path: "/v1/balance",
        };
        expect(await storage.recordBalanceQuery(input)).toEqual({ status: "recorded" });
        expect(await storage.recordBalanceQuery(input)).toEqual({ status: "replay", previousStatus: "committed" });
        expect((await storage.getSpentRequest("01BQ"))?.amountSats).toBe(0n);
      });
    });

    describe("deposits, reorgs, re-mine (M4)", () => {
      const depositInput = {
        identityId: "agent@",
        amountSats: 50_000n,
        currency: "VRSCTEST",
        txid: "aa11",
        vout: 0,
        blockHeight: 200,
        blockHash: "hash-200",
        confirmations: 10,
        detectedAt: T0,
        origin: "real" as const,
      };

      it("credit auto-provisions the identity on first deposit", async () => {
        const deposit = await storage.insertDeposit(depositInput);
        const credited = await storage.creditDeposit(deposit.id, T0 + 10);
        expect(credited).toEqual({ ok: true, balanceAfterSats: 50_000n, identityCreated: true });
        const identity = await storage.getIdentity("agent@");
        expect(identity?.firstDepositAt).toBe(T0 + 10);
        expect(await storage.creditDeposit(deposit.id, T0 + 11)).toEqual({ ok: false, reason: "already-credited" });
        await expectLedgerInvariants("agent@");
      });

      it("rejects duplicate (txid, vout) inserts", async () => {
        await storage.insertDeposit(depositInput);
        // matched by name+code, not instanceof — implementations may load the
        // error class from the built package (different class identity)
        await expect(storage.insertDeposit(depositInput)).rejects.toMatchObject({
          name: "StorageError",
          code: "duplicate-deposit",
        });
      });

      it("reorg of a credited deposit debits the balance, even into negative", async () => {
        const deposit = await storage.insertDeposit(depositInput);
        await storage.creditDeposit(deposit.id, T0 + 10);
        await storage.reservePayment(reserveInput("01A", "agent@", 40_000n));
        await storage.commitPayment("01A", 10, T0 + 20);

        const reorged = await storage.markDepositReorged(deposit.id, T0 + 30);
        expect(reorged).toEqual({ ok: true, wasCredited: true, balanceAfterSats: -40_000n });
        expect(await storage.markDepositReorged(deposit.id, T0 + 31)).toEqual({
          ok: false,
          reason: "already-reorged",
        });
        await expectLedgerInvariants("agent@");
      });

      it("reorg of an uncredited deposit moves no money", async () => {
        const deposit = await storage.insertDeposit(depositInput);
        expect(await storage.markDepositReorged(deposit.id, T0 + 5)).toEqual({ ok: true, wasCredited: false });
        expect(await storage.creditDeposit(deposit.id, T0 + 6)).toEqual({ ok: false, reason: "reorged" });
      });

      it("re-mine resets the deposit onto the normal credit path with a full audit trail", async () => {
        const deposit = await storage.insertDeposit(depositInput);
        await storage.creditDeposit(deposit.id, T0 + 10); // +50k
        await storage.markDepositReorged(deposit.id, T0 + 20); // −50k

        const remined = await storage.remineDeposit("aa11", 0, {
          blockHeight: 201,
          blockHash: "hash-201",
          confirmations: 0,
        });
        expect(remined?.reorgedAt).toBeUndefined();
        expect(remined?.creditedAt).toBeUndefined();
        expect(remined?.blockHeight).toBe(201);
        expect(await storage.listUncreditedDeposits()).toHaveLength(1);

        await storage.updateDepositConfirmations(deposit.id, 10);
        expect(await storage.creditDeposit(deposit.id, T0 + 40)).toEqual({
          ok: true,
          balanceAfterSats: 50_000n,
          identityCreated: false,
        });
        // full trail: deposit, reorg_adjust, deposit — 3 ledger rows
        expect((await storage.listLedgerEntries("agent@")).map((e) => e.kind)).toEqual([
          "deposit",
          "reorg_adjust",
          "deposit",
        ]);
        await expectLedgerInvariants("agent@");
      });

      it("lists non-reorged deposits at or above a height (reorg check)", async () => {
        const low = await storage.insertDeposit({ ...depositInput, txid: "low", blockHeight: 150 });
        const high = await storage.insertDeposit({ ...depositInput, txid: "high", blockHeight: 205 });
        const reorged = await storage.insertDeposit({ ...depositInput, txid: "gone", blockHeight: 210 });
        await storage.markDepositReorged(reorged.id, T0);
        const found = await storage.listDepositsAtOrAbove(200);
        expect(found.map((d) => d.id).sort()).toEqual([high.id]);
        expect((await storage.listDepositsAtOrAbove(100)).map((d) => d.id).sort()).toEqual([low.id, high.id]);
      });

      it("sums credited deposits, optionally excluding simulated ones", async () => {
        const real = await storage.insertDeposit(depositInput);
        const simulated = await storage.insertDeposit({
          ...depositInput,
          txid: "bb22",
          amountSats: 7_000n,
          origin: "simulated",
        });
        await storage.creditDeposit(real.id, T0 + 1);
        await storage.creditDeposit(simulated.id, T0 + 2);
        expect(await storage.sumCreditedDeposits()).toBe(57_000n);
        expect(await storage.sumCreditedDeposits({ excludeSimulated: true })).toBe(50_000n);
      });
    });

    describe("blocklist, cursor, reconciliation log", () => {
      it("block / unblock round-trip", async () => {
        expect(await storage.isBlocked("bad@")).toBe(false);
        await storage.blockIdentity({ identityId: "bad@", reason: "abuse", blockedAt: T0, blockedBy: "ops" });
        expect(await storage.isBlocked("bad@")).toBe(true);
        expect(await storage.listBlockedIdentities()).toHaveLength(1);
        expect(await storage.unblockIdentity("bad@")).toBe(true);
        expect(await storage.unblockIdentity("bad@")).toBe(false);
      });

      it("watcher cursor get/set overwrites", async () => {
        expect(await storage.getWatcherCursor("deposits")).toBeUndefined();
        await storage.setWatcherCursor("deposits", { lastBlock: 100, lastBlockHash: "h100", updatedAt: T0 });
        await storage.setWatcherCursor("deposits", { lastBlock: 101, lastBlockHash: "h101", updatedAt: T0 + 15 });
        expect(await storage.getWatcherCursor("deposits")).toEqual({
          lastBlock: 101,
          lastBlockHash: "h101",
          updatedAt: T0 + 15,
        });
      });

      it("reconciliation runs are recorded and listed newest-first", async () => {
        await storage.recordReconciliationRun({ runAt: T0, identitiesChecked: 5, mismatches: 0, durationMs: 12 });
        await storage.recordReconciliationRun({ runAt: T0 + 86_400, identitiesChecked: 6, mismatches: 1, durationMs: 15 });
        const runs = await storage.listReconciliationRuns();
        expect(runs).toHaveLength(2);
        expect(runs[0]?.runAt).toBe(T0 + 86_400);
      });

      it("lists identity ids for reconciliation iteration", async () => {
        await fund("a@", 1n, "tx-a");
        await fund("b@", 2n, "tx-b");
        expect((await storage.listIdentityIds()).sort()).toEqual(["a@", "b@"]);
      });
    });
  });
}
