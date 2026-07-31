/**
 * setup-position — open the monitored Aave V3 position (supply WETH, borrow USDC).
 *
 * INTENT: executed via the KeeperHub contract-call surface (kh CLI / MCP
 * execute_contract_call) in Session 2 — this script never signs or sends.
 * It resolves addresses from the config allowlist, builds the exact calldata,
 * and prints the intended calls so a human (or KeeperHub) can execute them.
 *
 * Prerequisite (documented, not encoded here): wrap ETH → WETH at the WETH
 * predeploy (deposit()), then WETH.approve(Pool, supplyAmount).
 *
 * Usage: pnpm exec tsx scripts/setup-position.ts --supply-eth 0.01 --borrow-usdc 10
 */

import { pathToFileURL } from "node:url";
import { encodeFunctionData, parseUnits } from "viem";
import { ADDRESS_BOOK, TOKEN_DECIMALS } from "../src/config.js";
import type { Address, Chain } from "../src/types.js";

export const POOL_ABI = [
  {
    type: "function",
    name: "supply",
    stateMutability: "nonpayable",
    inputs: [
      { name: "asset", type: "address" },
      { name: "amount", type: "uint256" },
      { name: "onBehalfOf", type: "address" },
      { name: "referralCode", type: "uint16" },
    ],
    outputs: [],
  },
  {
    type: "function",
    name: "borrow",
    stateMutability: "nonpayable",
    inputs: [
      { name: "asset", type: "address" },
      { name: "amount", type: "uint256" },
      { name: "interestRateMode", type: "uint256" },
      { name: "referralCode", type: "uint16" },
      { name: "onBehalfOf", type: "address" },
    ],
    outputs: [],
  },
] as const;

export interface IntendedCall {
  description: string;
  target: Address;
  functionName: string;
  args: readonly unknown[];
  calldata: `0x${string}`;
}

export function buildSetupCalls(
  chain: Chain,
  onBehalfOf: Address,
  supplyEth: string,
  borrowUsdc: string,
): IntendedCall[] {
  const book = ADDRESS_BOOK[chain];
  const supplyAmount = parseUnits(supplyEth, TOKEN_DECIMALS.WETH);
  const borrowAmount = parseUnits(borrowUsdc, TOKEN_DECIMALS.USDC);
  const supplyArgs = [book.weth.address, supplyAmount, onBehalfOf, 0] as const;
  const borrowArgs = [book.usdc.address, borrowAmount, 2n, 0, onBehalfOf] as const; // 2 = variable rate
  return [
    {
      description: `supply ${supplyEth} WETH as collateral`,
      target: book.aavePool.address,
      functionName: "supply",
      args: supplyArgs,
      calldata: encodeFunctionData({ abi: POOL_ABI, functionName: "supply", args: supplyArgs }),
    },
    {
      description: `borrow ${borrowUsdc} USDC (variable rate)`,
      target: book.aavePool.address,
      functionName: "borrow",
      args: borrowArgs,
      calldata: encodeFunctionData({ abi: POOL_ABI, functionName: "borrow", args: borrowArgs }),
    },
  ];
}

function argOf(flag: string, fallback: string): string {
  const i = process.argv.indexOf(flag);
  const v = i >= 0 ? process.argv[i + 1] : undefined;
  return v ?? fallback;
}

async function main(): Promise<void> {
  const { getConfig } = await import("../src/config.js");
  const cfg = await getConfig();
  const onBehalfOf = cfg.monitoredAddress;
  if (!onBehalfOf) {
    console.error("MONITORED_ADDRESS must be set to build position calls");
    process.exit(1);
  }
  const calls = buildSetupCalls(
    cfg.chain,
    onBehalfOf,
    argOf("--supply-eth", "0.01"),
    argOf("--borrow-usdc", "10"),
  );
  console.log(
    `# setup-position — intended calls on ${cfg.chain} (NOT sent; execute via KeeperHub)`,
  );
  console.log(
    "# prerequisite: wrap ETH→WETH (WETH.deposit) and WETH.approve(Pool, supplyAmount)\n",
  );
  for (const c of calls) {
    console.log(`## ${c.description}`);
    console.log(`   target:   ${c.target}`);
    console.log(`   function: ${c.functionName}(${c.args.map(String).join(", ")})`);
    console.log(`   calldata: ${c.calldata}\n`);
  }
}

const isMain =
  typeof process.argv[1] === "string" && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) main();
