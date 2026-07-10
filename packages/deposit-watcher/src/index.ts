export type {
  IWatcher,
  WatcherMode,
  WatcherPollResult,
  WatcherStatus,
  UnattributedReason,
} from "./types.js";
export { RealDepositWatcher, type RealWatcherConfig, type RealWatcherDeps } from "./real-watcher.js";
export {
  SimulatedDepositWatcher,
  type SimulatedWatcherConfig,
  type SimulateDepositInput,
} from "./simulated-watcher.js";
export { attributeSender, stripChainSuffix, emptyAttributionCaches, type AttributionResult } from "./attribution.js";
