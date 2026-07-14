# @chainvue/v402-facilitator

Standalone [v402](https://github.com/chainvue/v402) facilitator daemon — the server side of the payment layer, ready to deploy: verify / reserve / commit / rollback API, balance + topup + discovery endpoints, embedded deposit watcher, admin + reconciliation endpoints, background jobs (reaper, replay cleanup). NestJS, Pino JSON logs, Prometheus metrics, Zod-validated config, SQLite storage.

## Run it

The intended deployment is the container — see [docker/](https://github.com/chainvue/v402/tree/main/docker) and the compose files in the repo root.

The npm package exists for custom builds that embed or extend the daemon:

```sh
npm install @chainvue/v402-facilitator
```

```ts
import { AppModule, buildConfig, facilitatorConfigSchema } from "@chainvue/v402-facilitator";
// bootstrap AppModule with NestFactory, or compose it into your own Nest app
```

## Exports

- `AppModule` — the full NestJS application module
- `buildConfig` / `facilitatorConfigSchema` — Zod-validated config
- `MetricsModule`, DI tokens (`STORAGE`, `VERUS_RPC`, `VERIFIER_REGISTRY`, `WATCHER`), `hashIdentity`

## Good to know

- API contract: [`spec/0.1/facilitator-api.md`](https://github.com/chainvue/v402/blob/main/spec/0.1/facilitator-api.md) (normative, including the frozen error catalog).
- Operational notes and known boundaries: [docs/RISKS.md](https://github.com/chainvue/v402/blob/main/docs/RISKS.md).

## License

Apache-2.0
