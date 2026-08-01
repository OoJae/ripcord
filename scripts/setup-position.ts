/**
 * setup-position — open the monitored Aave V3 position (supply the chain's
 * collateral asset, borrow USDC).
 *
 * INTENT: executed via the KeeperHub contract-call surface (kh CLI / MCP
 * execute_contract_call) — this script never signs or sends. It resolves
 * addresses from the config allowlist, builds the exact calldata, and prints the
 * intended calls so a human (or KeeperHub) can execute them.
 *
 * The collateral asset is per-chain: WETH on Base, cbETH on Base Sepolia. On
 * Base Sepolia it is acquired from Aave's permissionless faucet — cbETH is a
 * plain ERC-20 with no deposit(), so there is nothing to "wrap".
 *
 * Usage: pnpm exec tsx scripts/setup-position.ts --supply-collateral 0.01 --borrow-usdc 10
 */

import { pathToFileURL } from "node:url";
import { encodeFunctionData, parseUnits } from "viem";
import { ADDRESS_BOOK, BASE_SEPOLIA_FAUCET, TOKEN_DECIMALS } from "../src/config.js";
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

export const ERC20_ABI = [
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

/** Aave's permissionless testnet faucet: mint(token, to, amount). */
export const FAUCET_ABI = [
  {
    type: "function",
    name: "mint",
    stateMutability: "nonpayable",
    inputs: [
      { name: "token", type: "address" },
      { name: "to", type: "address" },
      { name: "amount", type: "uint256" },
    ],
    outputs: [{ name: "", type: "uint256" }],
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
  supplyCollateral: string,
  borrowUsdc: string,
): IntendedCall[] {
  const book = ADDRESS_BOOK[chain];
  const symbol = book.collateral.symbol;
  const supplyAmount = parseUnits(supplyCollateral, book.collateral.decimals);
  const borrowAmount = parseUnits(borrowUsdc, TOKEN_DECIMALS.USDC);
  const calls: IntendedCall[] = [];

  // On testnet the collateral comes from Aave's faucet. On mainnet the operator
  // already holds WETH, so there is nothing to mint.
  if (chain === "base-sepolia") {
    const mintArgs = [book.collateral.address, onBehalfOf, supplyAmount] as const;
    calls.push({
      description: `mint ${supplyCollateral} ${symbol} from the Aave testnet faucet`,
      target: BASE_SEPOLIA_FAUCET,
      functionName: "mint",
      args: mintArgs,
      calldata: encodeFunctionData({ abi: FAUCET_ABI, functionName: "mint", args: mintArgs }),
    });
  }

  const approveArgs = [book.aavePool.address, supplyAmount] as const;
  calls.push({
    description: `approve ${supplyCollateral} ${symbol} to the Aave Pool`,
    target: book.collateral.address,
    functionName: "approve",
    args: approveArgs,
    calldata: encodeFunctionData({ abi: ERC20_ABI, functionName: "approve", args: approveArgs }),
  });

  const supplyArgs = [book.collateral.address, supplyAmount, onBehalfOf, 0] as const;
  calls.push({
    description: `supply ${supplyCollateral} ${symbol} as collateral`,
    target: book.aavePool.address,
    functionName: "supply",
    args: supplyArgs,
    calldata: encodeFunctionData({ abi: POOL_ABI, functionName: "supply", args: supplyArgs }),
  });

  const borrowArgs = [book.usdc.address, borrowAmount, 2n, 0, onBehalfOf] as const; // 2 = variable rate
  calls.push({
    description: `borrow ${borrowUsdc} USDC (variable rate)`,
    target: book.aavePool.address,
    functionName: "borrow",
    args: borrowArgs,
    calldata: encodeFunctionData({ abi: POOL_ABI, functionName: "borrow", args: borrowArgs }),
  });

  return calls;
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
    argOf("--supply-collateral", "0.01"),
    argOf("--borrow-usdc", "10"),
  );
  console.log(
    `# setup-position — intended calls on ${cfg.chain} (NOT sent; execute via KeeperHub)`,
  );
  console.log(`# collateral asset: ${ADDRESS_BOOK[cfg.chain].collateral.symbol}. Run in order.\n`);
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
