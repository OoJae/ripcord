/**
 * risk-score — score any Aave V3 position with Ripcord's deterministic engine.
 *
 * Two input modes:
 *   pnpm exec tsx scripts/risk-score.ts --address 0x…          # live RPC read
 *   pnpm exec tsx scripts/risk-score.ts --json response.json   # a paid WF-3
 *       `ripcord-risk-score` response body — the composed "pays for itself"
 *       demo: the marketplace returns the raw figures, this scores them.
 *
 * READ-ONLY: viem reads, no signing, no writes (invariant 1).
 */

import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { createPublicClient, http } from "viem";
import { ADDRESS_BOOK, DEFAULT_RPC_URLS } from "../src/config.js";
import type { RiskReport } from "../src/risk/engine.js";
import { riskFromAccountData } from "../src/risk/engine.js";
import type { Chain } from "../src/types.js";

const ACCOUNT_DATA_ABI = [
  {
    type: "function",
    name: "getUserAccountData",
    stateMutability: "view",
    inputs: [{ name: "user", type: "address" }],
    outputs: [
      { name: "totalCollateralBase", type: "uint256" },
      { name: "totalDebtBase", type: "uint256" },
      { name: "availableBorrowsBase", type: "uint256" },
      { name: "currentLiquidationThreshold", type: "uint256" },
      { name: "ltv", type: "uint256" },
      { name: "healthFactor", type: "uint256" },
    ],
  },
] as const;

function argOf(flag: string): string | undefined {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

function render(report: RiskReport, source: string): void {
  console.log(`\n🪂 Ripcord risk report — ${source}`);
  console.log(`   SCORE ${report.score}/100 · grade ${report.grade.toUpperCase()}`);
  for (const [name, f] of Object.entries(report.factors)) {
    const bar = "█".repeat(Math.round(f.value / 5)).padEnd(20, "·");
    console.log(
      `   ${name.padEnd(20)} ${bar} ${String(Math.round(f.value)).padStart(3)} ×${f.weight}  ${f.detail}`,
    );
  }
  const flags = Object.entries(report.flags)
    .filter(([, v]) => v)
    .map(([k]) => k);
  if (flags.length > 0) console.log(`   flags: ${flags.join(", ")}`);
  console.log();
}

async function main(): Promise<void> {
  const jsonPath = argOf("--json");
  if (jsonPath !== undefined) {
    // A WF-3 `ripcord-risk-score` response body. Two shapes are accepted:
    //  - the listing's outputMapping names (healthFactorWad, totalCollateralBase8, …)
    //  - the raw /call output.result ABI names (healthFactor, totalCollateralBase, …),
    //    which is what the paid endpoint actually returns today (the platform
    //    stores outputMapping but does not apply it — see FRICTION.md).
    const parsed = JSON.parse(readFileSync(jsonPath, "utf8")) as Record<string, unknown>;
    const body = ((parsed.output as Record<string, unknown>)?.result ??
      parsed.result ??
      parsed) as Record<string, string | number>;
    const pick = (...names: string[]): bigint => {
      for (const n of names) {
        const v = body[n];
        if (v !== undefined && v !== null) return BigInt(v);
      }
      throw new Error(`response JSON missing all of: ${names.join(", ")}`);
    };
    const report = riskFromAccountData({
      healthFactorWad: pick("healthFactorWad", "healthFactor"),
      totalCollateralBase8: pick("totalCollateralBase8", "totalCollateralBase"),
      totalDebtBase8: pick("totalDebtBase8", "totalDebtBase"),
      availableBorrowsBase8: BigInt(body.availableBorrowsBase8 ?? body.availableBorrowsBase ?? 0),
      collateralSymbol:
        typeof body.collateralSymbol === "string" ? body.collateralSymbol : undefined,
    });
    render(report, `WF-3 response ${jsonPath}`);
    return;
  }

  const address = argOf("--address");
  if (address === undefined || !/^0x[0-9a-fA-F]{40}$/.test(address)) {
    console.error("usage: risk-score --address 0x…  |  --json <wf3-response.json>");
    process.exit(1);
  }
  const chain = (argOf("--chain") ?? "base") as Chain;
  const book = ADDRESS_BOOK[chain];
  const rpc =
    (chain === "base" ? process.env.BASE_RPC_URL : process.env.BASE_SEPOLIA_RPC_URL) ??
    DEFAULT_RPC_URLS[chain];
  const client = createPublicClient({ transport: http(rpc) });
  const [collateral, debt, available, , , hfWad] = (await client.readContract({
    address: book.aavePool.address,
    abi: ACCOUNT_DATA_ABI,
    functionName: "getUserAccountData",
    args: [address as `0x${string}`],
  })) as unknown as readonly [bigint, bigint, bigint, bigint, bigint, bigint];

  const report = riskFromAccountData({
    healthFactorWad: hfWad,
    totalCollateralBase8: collateral,
    totalDebtBase8: debt,
    availableBorrowsBase8: available,
    collateralSymbol: book.collateral.symbol,
  });
  render(report, `${address} on ${chain} (live read)`);
}

const isMain =
  typeof process.argv[1] === "string" && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) main();
