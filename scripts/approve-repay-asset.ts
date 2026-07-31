/**
 * approve-repay-asset — pre-approve a CAPPED USDC allowance to the Aave Pool
 * so a defense is a single fast tx.
 *
 * Security posture (documented for judges): the allowance is capped at
 * 2 × DAILY_CAP_USD, revocable at any time (approve 0), and listed in the
 * README. INTENT: executed via KeeperHub (public mempool + gas sponsorship on
 * mainnet setup) in Sessions 2–3 — this script never signs or sends.
 *
 * Usage: pnpm exec tsx scripts/approve-repay-asset.ts
 */

import { pathToFileURL } from "node:url";
import { encodeFunctionData, parseUnits } from "viem";
import { ADDRESS_BOOK, TOKEN_DECIMALS } from "../src/config.js";
import type { Chain } from "../src/types.js";
import type { IntendedCall } from "./setup-position.js";

export const ERC20_APPROVE_ABI = [
  {
    type: "function",
    name: "approve",
    stateMutability: "nonpayable",
    inputs: [
      { name: "spender", type: "address" },
      { name: "amount", type: "uint256" },
    ],
    outputs: [{ name: "", type: "bool" }],
  },
] as const;

export function buildApproveCall(chain: Chain, dailyCapUsd: number): IntendedCall {
  const book = ADDRESS_BOOK[chain];
  const capUsd = (dailyCapUsd * 2).toFixed(TOKEN_DECIMALS.USDC);
  const amount = parseUnits(capUsd, TOKEN_DECIMALS.USDC);
  const args = [book.aavePool.address, amount] as const;
  return {
    description: `approve Pool to spend up to $${capUsd} USDC (2 × DAILY_CAP_USD, revocable)`,
    target: book.usdc.address,
    functionName: "approve",
    args,
    calldata: encodeFunctionData({ abi: ERC20_APPROVE_ABI, functionName: "approve", args }),
  };
}

async function main(): Promise<void> {
  const { getConfig } = await import("../src/config.js");
  const cfg = await getConfig();
  const call = buildApproveCall(cfg.chain, cfg.caps.dailyCapUsd);
  console.log(
    `# approve-repay-asset — intended call on ${cfg.chain} (NOT sent; execute via KeeperHub)`,
  );
  console.log(`## ${call.description}`);
  console.log(`   target:   ${call.target}`);
  console.log(`   function: ${call.functionName}(${call.args.map(String).join(", ")})`);
  console.log(`   calldata: ${call.calldata}`);
  console.log("\n# revoke later with: approve(Pool, 0)");
}

const isMain =
  typeof process.argv[1] === "string" && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) main();
