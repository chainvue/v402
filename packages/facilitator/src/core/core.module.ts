import {
  Module,
  type DynamicModule,
  type OnApplicationBootstrap,
  type OnApplicationShutdown,
} from "@nestjs/common";
import { Inject, Injectable } from "@nestjs/common";
import { RealDepositWatcher, SimulatedDepositWatcher, type IWatcher } from "@chainvue/v402-deposit-watcher";
import type { IStorage } from "@chainvue/v402-storage";
import { SqliteStorage } from "@chainvue/v402-storage-sqlite";
import { VerusRpcClient, type IVerusRpc } from "@chainvue/v402-verus-rpc";
import { CachedIdentityProvider, VerifierRegistry, VerusPrepaidSigVerifier } from "@chainvue/v402-verifier";
import { SCHEME_VERUS_PREPAID_SIG } from "@chainvue/v402-protocol";
import { V402_CONFIG } from "../config/config.module.js";
import type { FacilitatorConfig } from "../config/schema.js";

export const STORAGE = Symbol("STORAGE");
export const VERUS_RPC = Symbol("VERUS_RPC");
export const VERIFIER_REGISTRY = Symbol("VERIFIER_REGISTRY");
export const WATCHER = Symbol("WATCHER");

@Injectable()
class StorageLifecycle implements OnApplicationShutdown {
  constructor(@Inject(STORAGE) private readonly storage: IStorage) {}

  async onApplicationShutdown(): Promise<void> {
    await this.storage.close();
  }
}

@Injectable()
class WatcherLifecycle implements OnApplicationBootstrap, OnApplicationShutdown {
  constructor(@Inject(WATCHER) private readonly watcher: IWatcher) {}

  onApplicationBootstrap(): void {
    this.watcher.start();
  }

  async onApplicationShutdown(): Promise<void> {
    await this.watcher.stop();
  }
}

/**
 * Wires the payment stack into DI: SQLite storage (initialized before the
 * app accepts traffic), the Verus RPC client, and the multi-scheme verifier
 * registry with the enabled schemes from config.
 */
@Module({})
export class CoreModule {
  static forRoot(): DynamicModule {
    return {
      module: CoreModule,
      global: true,
      providers: [
        {
          provide: STORAGE,
          inject: [V402_CONFIG],
          useFactory: async (config: FacilitatorConfig): Promise<IStorage> => {
            const storage = new SqliteStorage({ path: config.db.path, walMode: config.db.walMode });
            await storage.initialize();
            return storage;
          },
        },
        {
          provide: VERUS_RPC,
          inject: [V402_CONFIG],
          useFactory: (config: FacilitatorConfig): IVerusRpc =>
            new VerusRpcClient({
              rpcUrl: config.verus.rpcUrl,
              rpcUser: config.verus.rpcUser,
              rpcPass: config.verus.rpcPass,
              circuit: config.verus.circuit,
            }),
        },
        {
          provide: VERIFIER_REGISTRY,
          inject: [V402_CONFIG, STORAGE, VERUS_RPC],
          useFactory: (config: FacilitatorConfig, storage: IStorage, rpc: IVerusRpc): VerifierRegistry => {
            const registry = new VerifierRegistry();
            for (const scheme of config.schemes) {
              if (!scheme.enabled) continue;
              if (scheme.name === SCHEME_VERUS_PREPAID_SIG) {
                registry.register(
                  new VerusPrepaidSigVerifier({
                    storage,
                    rpc,
                    ...(config.verifier.mode === "offline"
                      ? {
                          identityProvider: new CachedIdentityProvider(rpc, {
                            ttlSec: config.verifier.identityCacheTtlSec,
                            maxEntries: config.verifier.identityCacheMaxSize,
                          }),
                        }
                      : {}),
                    config: {
                      network: config.verus.chain,
                      asset: scheme.config.asset,
                      payTo: scheme.config.payToIdentity,
                      canonicalDomain: config.payment.canonicalDomain,
                      timestampToleranceSec: config.payment.timestampToleranceSec,
                      maxExtensionsBytes: config.payment.maxExtensionsBytes,
                      verificationMode: config.verifier.mode,
                      identityCacheTtlSec: config.verifier.identityCacheTtlSec,
                    },
                  }),
                );
              } else {
                // config validation guards defaultScheme; an unknown enabled scheme is a boot error
                throw new Error(`no verifier implementation for enabled scheme "${scheme.name}"`);
              }
            }
            return registry;
          },
        },
        {
          provide: WATCHER,
          inject: [V402_CONFIG, STORAGE, VERUS_RPC],
          useFactory: (config: FacilitatorConfig, storage: IStorage, rpc: IVerusRpc): IWatcher => {
            const currency = config.schemes[0]!.config.asset;
            if (config.watcher.mode === "simulated") {
              return new SimulatedDepositWatcher({
                storage,
                config: {
                  currency,
                  minConfirmations: config.watcher.minConfirmations,
                  nodeEnv: config.nodeEnv,
                  allowInProduction: config.ops.allowSimulatedInProd,
                },
              });
            }
            return new RealDepositWatcher({
              rpc,
              storage,
              config: {
                payToIdentity: config.schemes[0]!.config.payToIdentity,
                chainName: config.verus.chain,
                currency,
                intervalMs: config.watcher.intervalMs,
                minConfirmations: config.watcher.minConfirmations,
                reorgLookbackBlocks: config.watcher.reorgLookbackBlocks,
              },
            });
          },
        },
        StorageLifecycle,
        WatcherLifecycle,
      ],
      exports: [STORAGE, VERUS_RPC, VERIFIER_REGISTRY, WATCHER],
    };
  }
}
