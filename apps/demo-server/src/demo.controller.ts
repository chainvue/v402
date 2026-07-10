import { Body, Controller, Get, Param, Post } from "@nestjs/common";
import { V402Payment } from "@chainvue/v402-nestjs";

/**
 * Static-response endpoints proving the payment flow (plan step 19).
 * Three price points plus a bodyHash-bound POST — the reference pattern for
 * constant-path protocols (GraphQL/MCP/JSON-RPC), where request semantics
 * live in the body and scheme.bodyHash binds the payment to it.
 */
@Controller()
export class DemoController {
  /** Free: service info + the rate card. */
  @Get()
  index(): unknown {
    return {
      service: "v402 demo server",
      docs: "https://github.com/chainvue/v402",
      endpoints: [
        { method: "GET", path: "/api/status", price: "0.0001" },
        { method: "GET", path: "/api/tx/:txid", price: "0.001" },
        { method: "GET", path: "/api/report", price: "0.01" },
        { method: "POST", path: "/api/graphql", price: "0.002", bodyHash: "required" },
      ],
    };
  }

  @Get("api/status")
  @V402Payment("0.0001")
  status(): unknown {
    return { chain: "VRSCTEST", synced: true, blocks: 1_140_000 };
  }

  @Get("api/tx/:txid")
  @V402Payment("0.001")
  transaction(@Param("txid") txid: string): unknown {
    return {
      txid,
      blockHeight: 1_054_312,
      confirmations: 86_148,
      vout: [{ n: 0, value: "500.00000000", addresses: ["ownora-nft@"] }],
    };
  }

  @Get("api/report")
  @V402Payment("0.01")
  report(): unknown {
    return {
      period: "2026-07",
      totals: { transactions: 48_211, volume: "1204531.55" },
      topIdentities: ["fum@", "ownora-nft@", "v402test.demoAgent@"],
    };
  }

  /** GraphQL-style single endpoint: the path never changes, the body decides — bodyHash is mandatory. */
  @Post("api/graphql")
  @V402Payment("0.002", { bodyHash: "required" })
  graphql(@Body() body: { query?: string }): unknown {
    return { data: { echo: body.query ?? null } };
  }
}
