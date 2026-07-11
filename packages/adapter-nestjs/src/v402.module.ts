import { Inject, Injectable, Module, type DynamicModule, type OnApplicationShutdown } from "@nestjs/common";
import { APP_GUARD, APP_INTERCEPTOR, DiscoveryModule } from "@nestjs/core";
import { V402DiscoveryController } from "./discovery.controller.js";
import { SCHEME_VERUS_PREPAID_SIG } from "@chainvue/v402-protocol";
import type { IStorage } from "@chainvue/v402-storage";
import { SqliteStorage } from "@chainvue/v402-storage-sqlite";
import { VerusRpcClient } from "@chainvue/v402-verus-rpc";
import { HttpFacilitatorVerifier, VerifierRegistry, VerusPrepaidSigVerifier } from "@chainvue/v402-verifier";
import { PaymentGuard, V402_ADVERTISEMENT, V402_REGISTRY } from "./payment.guard.js";
import { PaymentInterceptor } from "./payment.interceptor.js";
import type { PaymentAdvertisement, V402ModuleOptions } from "./types.js";

const V402_OWNED_STORAGE = Symbol("V402_OWNED_STORAGE");

@Injectable()
class OwnedStorageLifecycle implements OnApplicationShutdown {
  constructor(@Inject(V402_OWNED_STORAGE) private readonly storage: IStorage | undefined) {}

  async onApplicationShutdown(): Promise<void> {
    await this.storage?.close();
  }
}

/**
 * One-line server-side adoption (plan DX goal):
 *
 *   imports: [V402Module.forRoot({ canonicalDomain, network, asset, payTo, … })]
 *
 * then price routes with `@V402Payment("0.001")`. Registers PaymentGuard +
 * PaymentInterceptor globally; undecorated routes are untouched.
 * Modes: "in-process" builds the verifier stack locally (SQLite + Verus
 * RPC); "http" delegates to a facilitator — switching is a config change.
 */
@Module({})
export class V402Module {
  static forRoot(options: V402ModuleOptions): DynamicModule {
    const advertisement: PaymentAdvertisement = {
      canonicalDomain: options.canonicalDomain,
      network: options.network,
      asset: options.asset,
      payTo: options.payTo,
      facilitatorUrl: options.facilitatorUrl,
    };
    return {
      module: V402Module,
      global: true,
      imports: [DiscoveryModule],
      // discovery: false opts out for apps that serve their own document
      controllers: options.discovery === false ? [] : [V402DiscoveryController],
      providers: [
        { provide: V402_ADVERTISEMENT, useValue: advertisement },
        {
          provide: V402_OWNED_STORAGE,
          useFactory: async (): Promise<IStorage | undefined> => {
            if (options.mode === "http" || options.storage !== undefined) return undefined;
            const storage = new SqliteStorage({ path: options.db.path, walMode: options.db.walMode ?? true });
            await storage.initialize();
            return storage;
          },
        },
        {
          provide: V402_REGISTRY,
          inject: [V402_OWNED_STORAGE],
          useFactory: (ownedStorage: IStorage | undefined): VerifierRegistry => {
            const registry = new VerifierRegistry();
            if (options.mode === "http") {
              registry.register(
                new HttpFacilitatorVerifier({
                  scheme: SCHEME_VERUS_PREPAID_SIG,
                  baseUrl: options.facilitatorInternalUrl ?? options.facilitatorUrl,
                  authToken: options.facilitatorAuthToken,
                  ...(options.middlewareId !== undefined ? { middlewareId: options.middlewareId } : {}),
                  ...(options.fetchImpl !== undefined ? { fetchImpl: options.fetchImpl } : {}),
                }),
              );
              return registry;
            }
            const storage = options.storage ?? ownedStorage;
            if (!storage) throw new Error("v402: no storage available"); // unreachable by construction
            registry.register(
              new VerusPrepaidSigVerifier({
                storage,
                rpc: options.verusRpc ?? new VerusRpcClient(options.verus),
                config: {
                  network: options.network,
                  asset: options.asset,
                  payTo: options.payTo,
                  canonicalDomain: options.canonicalDomain,
                  ...(options.timestampToleranceSec !== undefined
                    ? { timestampToleranceSec: options.timestampToleranceSec }
                    : {}),
                  ...(options.maxExtensionsBytes !== undefined
                    ? { maxExtensionsBytes: options.maxExtensionsBytes }
                    : {}),
                },
              }),
            );
            return registry;
          },
        },
        OwnedStorageLifecycle,
        { provide: APP_GUARD, useClass: PaymentGuard },
        { provide: APP_INTERCEPTOR, useClass: PaymentInterceptor },
      ],
      exports: [V402_REGISTRY, V402_ADVERTISEMENT],
    };
  }
}
