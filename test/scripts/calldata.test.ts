/**
 * The setup/stress/approve scripts never sign or send — they print intended
 * calls. These tests pin the encoded calldata so a wrong selector or a wrong
 * decimal scale is caught here rather than on a live chain.
 */

import { toFunctionSelector } from "viem";
import { describe, expect, it } from "vitest";
import { buildApproveCall } from "../../scripts/approve-repay-asset.js";
import { buildSetupCalls } from "../../scripts/setup-position.js";
import { buildStressCall } from "../../scripts/stress-position.js";
import { ADDRESS_BOOK, BASE_SEPOLIA_FAUCET } from "../../src/config.js";
import { TEST_ADDRESS } from "../helpers/fakes.js";

const SUPPLY = toFunctionSelector("supply(address,uint256,address,uint16)");
const BORROW = toFunctionSelector("borrow(address,uint256,uint256,uint16,address)");
const WITHDRAW = toFunctionSelector("withdraw(address,uint256,address)");
const APPROVE = toFunctionSelector("approve(address,uint256)");
const MINT = toFunctionSelector("mint(address,address,uint256)");

describe("scripts: setup-position", () => {
  it("encodes faucet-mint → approve → supply → borrow on Base Sepolia", () => {
    const book = ADDRESS_BOOK["base-sepolia"];
    const calls = buildSetupCalls("base-sepolia", TEST_ADDRESS, "0.01", "10");
    expect(calls).toHaveLength(4);

    const [mint, approve, supply, borrow] = calls;

    // The Sepolia collateral is a plain ERC-20 minted from Aave's faucet — it is
    // NOT the WETH predeploy, so there is no deposit() step to encode.
    expect(mint?.target).toBe(BASE_SEPOLIA_FAUCET);
    expect(mint?.calldata.startsWith(MINT)).toBe(true);
    expect(mint?.args[0]).toBe(book.collateral.address);
    expect(mint?.description).toContain(book.collateral.symbol);

    expect(approve?.target).toBe(book.collateral.address);
    expect(approve?.calldata.startsWith(APPROVE)).toBe(true);
    expect(approve?.args[0]).toBe(book.aavePool.address);

    expect(supply?.target).toBe(book.aavePool.address);
    expect(supply?.calldata.startsWith(SUPPLY)).toBe(true);
    expect(supply?.args[0]).toBe(book.collateral.address);
    expect(supply?.args[1]).toBe(10_000_000_000_000_000n); // 0.01 collateral, 18 dec

    expect(borrow?.calldata.startsWith(BORROW)).toBe(true);
    expect(borrow?.args[0]).toBe(book.usdc.address);
    expect(borrow?.args[1]).toBe(10_000_000n); // $10 USDC, 6 dec
    expect(borrow?.args[2]).toBe(2n); // variable interest-rate mode
  });

  it("omits the faucet step on mainnet and uses the mainnet allowlist", () => {
    const calls = buildSetupCalls("base", TEST_ADDRESS, "0.01", "10");
    expect(calls).toHaveLength(3); // no faucet on mainnet
    expect(calls.some((c) => c.target === BASE_SEPOLIA_FAUCET)).toBe(false);

    const supply = calls.find((c) => c.functionName === "supply");
    expect(supply?.target).toBe(ADDRESS_BOOK.base.aavePool.address);
    expect(supply?.args[0]).toBe(ADDRESS_BOOK.base.collateral.address);
  });

  it("names the chain's real collateral symbol, not a hardcoded WETH", () => {
    const sepolia = buildSetupCalls("base-sepolia", TEST_ADDRESS, "0.01", "10");
    const mainnet = buildSetupCalls("base", TEST_ADDRESS, "0.01", "10");
    expect(sepolia.find((c) => c.functionName === "supply")?.description).toContain("cbETH");
    expect(mainnet.find((c) => c.functionName === "supply")?.description).toContain("WETH");
  });
});

describe("scripts: stress-position", () => {
  it("encodes an extra borrow", () => {
    const call = buildStressCall("base-sepolia", TEST_ADDRESS, { borrowUsdc: "5" });
    expect(call.calldata.startsWith(BORROW)).toBe(true);
    expect(call.args[1]).toBe(5_000_000n);
  });

  it("encodes a collateral withdrawal against the chain's collateral asset", () => {
    const call = buildStressCall("base-sepolia", TEST_ADDRESS, { withdrawCollateral: "0.002" });
    expect(call.calldata.startsWith(WITHDRAW)).toBe(true);
    expect(call.args[0]).toBe(ADDRESS_BOOK["base-sepolia"].collateral.address);
    expect(call.args[1]).toBe(2_000_000_000_000_000n);
    expect(call.description).toContain("cbETH");
  });

  it("refuses to build a call with no stress mode chosen", () => {
    expect(() => buildStressCall("base-sepolia", TEST_ADDRESS, {})).toThrow(/--borrow-usdc/);
  });
});

describe("scripts: approve-repay-asset", () => {
  it("caps the allowance at 2x the daily cap and targets the allowlisted USDC", () => {
    const call = buildApproveCall("base-sepolia", 30);
    expect(call.target).toBe(ADDRESS_BOOK["base-sepolia"].usdc.address);
    expect(call.calldata.startsWith(APPROVE)).toBe(true);
    expect(call.args[0]).toBe(ADDRESS_BOOK["base-sepolia"].aavePool.address);
    expect(call.args[1]).toBe(60_000_000n); // $60 = 2 x $30 daily cap, 6 dec
    expect(call.description).toMatch(/revocable/);
  });

  it("is not an unlimited approval", () => {
    const call = buildApproveCall("base", 30);
    expect(call.args[1]).not.toBe(2n ** 256n - 1n);
    expect(call.args[1]).toBeLessThan(1_000_000_000n);
  });
});
