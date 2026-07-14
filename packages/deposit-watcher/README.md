# @chainvue/v402-deposit-watcher

Deposit watcher for the [v402](https://github.com/chainvue/v402) facilitator: turns on-chain VerusID deposits into credited balances. Runs embedded in the facilitator daemon; published separately so custom builds can reuse it.

```sh
npm install @chainvue/v402-deposit-watcher
```

## What it does

- `RealDepositWatcher` — polls blocks via [`@chainvue/v402-verus-rpc`](https://www.npmjs.com/package/@chainvue/v402-verus-rpc), attributes each deposit to the sending VerusID (source-tx vin lookup), credits after the configured confirmation depth
- Reorg detection — on a suspected reorg it re-verifies the block hashes of **all** recorded deposits, so deep reorgs alarm instead of passing silently
- `SimulatedDepositWatcher` — production-guarded fake deposits for dev/CI without a Verus node
- `attributeSender()` / `stripChainSuffix()` — attribution helpers

## Good to know

- Shielded funding has no transparent vins → flagged for manual reconciliation (by design; see [docs/RISKS.md](https://github.com/chainvue/v402/blob/main/docs/RISKS.md)).
- Amounts use the daemon's exact `valueSat`.

## License

Apache-2.0
