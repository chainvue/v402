# @chainvue/v402-deposit-watcher

Deposit watcher for the [v402](https://github.com/chainvue/v402) facilitator.
Real mode (`RealDepositWatcher`) polls blocks via
[`@chainvue/v402-verus-rpc`](https://www.npmjs.com/package/@chainvue/v402-verus-rpc),
attributes deposits to the sending VerusID (source-tx vin lookup), credits
balances after the configured confirmation depth, and detects reorgs — on a
suspected reorg it re-verifies the block hashes of **all** recorded deposits so
deep reorgs alarm instead of passing silently. Simulated mode fakes deposits
for dev/CI without a Verus node (production-guarded).

Runs embedded in the facilitator daemon; published separately so custom
facilitator builds can reuse it.

```sh
npm install @chainvue/v402-deposit-watcher
```

Known boundaries (by design, see the repo's
[docs/RISKS.md](https://github.com/chainvue/v402/blob/main/docs/RISKS.md)):
shielded funding has no transparent vins → flagged for manual reconciliation;
amounts use the daemon's exact `valueSat`.

## License

Apache-2.0
