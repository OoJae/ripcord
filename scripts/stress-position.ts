/**
 * stress-position — push the monitored position's HF down for demos
 * (borrow more USDC, or withdraw some collateral).
 *
 * INTENT: executed via the KeeperHub contract-call surface in Session 2 —
 * this script never signs or sends; it prints the exact intended call.
 *
 * Fallback note (build guide §6.9): if the Base Sepolia Aave market ever turns
 * illiquid, the drama loop moves to an Anvil fork of Base mainnet — verified
 * 2026-07-30 the Sepolia market is live (6 reserves), so this is unlikely.
 *
 * Usage: pnpm exec tsx scripts/stress-position.ts --borrow-usdc 5
 *        pnpm exec tsx scripts/stress-position.ts --withdraw-collateral 0.002
 */

import { pathToFileURL } from "node:url";
import { encodeFunctionData, parseUnits } from "viem";
import { ADDRESS_BOOK, TOKEN_DECIMALS } from "../src/config.js";
import type { Address, Chain } from "../src/types.js";
import { type IntendedCall, POOL_ABI } from "./setup-position.js";

export const WITHDRAW_ABI = [
  {
    type: "function",
    name: "withdraw",
    stateMutability: "nonpayable",
    inputs: [
      { name: "asset", type: "address" },
      { name: "amount", type: "uint256" },
      { name: "to", type: "address" },
    ],
    outputs: [{ name: "", type: "uint256" }],
  },
] as const;

export function buildStressCall(
  chain: Chain,
  account: Address,
  opts: { borrowUsdc?: string; withdrawCollateral?: string },
): IntendedCall {
  const book = ADDRESS_BOOK[chain];
  if (opts.borrowUsdc) {
    const amount = parseUnits(opts.borrowUsdc, TOKEN_DECIMALS.USDC);
    const args = [book.usdc.address, amount, 2n, 0, account] as const;
    return {
      description: `borrow ${opts.borrowUsdc} more USDC (pushes HF down)`,
      target: book.aavePool.address,
      functionName: "borrow",
      args,
      calldata: encodeFunctionData({ abi: POOL_ABI, functionName: "borrow", args }),
    };
  }
  if (opts.withdrawCollateral) {
    const amount = parseUnits(opts.withdrawCollateral, book.collateral.decimals);
    const args = [book.collateral.address, amount, account] as const;
    return {
      description: `withdraw ${opts.withdrawCollateral} ${book.collateral.symbol} collateral (pushes HF down)`,
      target: book.aavePool.address,
      functionName: "withdraw",
      args,
      calldata: encodeFunctionData({ abi: WITHDRAW_ABI, functionName: "withdraw", args }),
    };
  }
  throw new Error("pass --borrow-usdc <amount> or --withdraw-collateral <amount>");
}

function argOf(flag: string): string | undefined {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function main(): Promise<void> {
  const { getConfig } = await import("../src/config.js");
  const cfg = await getConfig();
  if (!cfg.monitoredAddress) {
    console.error("MONITORED_ADDRESS must be set");
    process.exit(1);
  }
  const call = buildStressCall(cfg.chain, cfg.monitoredAddress, {
    borrowUsdc: argOf("--borrow-usdc"),
    withdrawCollateral: argOf("--withdraw-collateral"),
  });
  console.log(
    `# stress-position — intended call on ${cfg.chain} (NOT sent; execute via KeeperHub)`,
  );
  console.log(`## ${call.description}`);
  console.log(`   target:   ${call.target}`);
  console.log(`   function: ${call.functionName}(${call.args.map(String).join(", ")})`);
  console.log(`   calldata: ${call.calldata}`);
}

const isMain =
  typeof process.argv[1] === "string" && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) main();
