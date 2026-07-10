import { describe, expect, it } from "vitest";
import { InMemoryStorage } from "@chainvue/v402-storage";
import { SimulatedDepositWatcher } from "../src/index.js";

const T0 = 1_783_650_000;

async function makeWatcher(config: { nodeEnv?: string; allowInProduction?: boolean } = {}) {
  const storage = new InMemoryStorage();
  await storage.initialize();
  const watcher = new SimulatedDepositWatcher({
    storage,
    config: { currency: "VRSCTEST", nodeEnv: config.nodeEnv ?? "test", ...config },
    now: () => T0,
  });
  return { watcher, storage };
}

describe("SimulatedDepositWatcher", () => {
  it("credits fake deposits immediately with normalized identity and origin=simulated", async () => {
    const { watcher, storage } = await makeWatcher();
    const result = await watcher.simulateDeposit({ identity: "v402.DemoAgent@", amountSats: 500_000n });
    expect(result.balanceAfterSats).toBe(500_000n);
    expect(result.deposit.origin).toBe("simulated");
    const identity = await storage.getIdentity("v402.demoagent@");
    expect(identity?.balanceSats).toBe(500_000n);
    expect(await storage.sumCreditedDeposits({ excludeSimulated: true })).toBe(0n);
  });

  it("propagates duplicate txids as StorageError", async () => {
    const { watcher } = await makeWatcher();
    await watcher.simulateDeposit({ identity: "a@", amountSats: 1n, txid: "sim-fixed" });
    await expect(watcher.simulateDeposit({ identity: "a@", amountSats: 1n, txid: "sim-fixed" })).rejects.toMatchObject({
      name: "StorageError",
      code: "duplicate-deposit",
    });
  });

  it("refuses to boot in production without the explicit override", async () => {
    await expect(makeWatcher({ nodeEnv: "production" })).rejects.toThrow(/V402_ALLOW_SIMULATED_IN_PROD/);
  });

  it("boots in production with the explicit override", async () => {
    const { watcher } = await makeWatcher({ nodeEnv: "production", allowInProduction: true });
    expect(watcher.mode).toBe("simulated");
  });

  it("pollOnce/status keep interface parity with the real watcher", async () => {
    const { watcher } = await makeWatcher();
    watcher.start();
    const poll = await watcher.pollOnce();
    expect(poll.inserted).toBe(0);
    expect(watcher.status()).toMatchObject({ mode: "simulated", running: true, lagBlocks: 0 });
    await watcher.stop();
    expect(watcher.status().running).toBe(false);
  });
});
