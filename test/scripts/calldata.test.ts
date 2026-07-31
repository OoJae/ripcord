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
import { ADDRESS_BOOK } from "../../src/config.js";
import { TEST_ADDRESS } from "../helpers/fakes.js";

const SUPPLY = toFunctionSelector("supply(address,uint256,address,uint16)");
const BORROW = toFunctionSelector("borrow(address,uint256,uint256,uint16,address)");
const WITHDRAW = toFunctionSelector("withdraw(address,uint256,address)");
const APPROVE = toFunctionSelector("approve(address,uint256)");

describe("scripts: setup-position", () => {
  it("encodes supply(WETH) then borrow(USDC) against the allowlisted Pool", () => {
    const calls = buildSetupCalls("base-sepolia", TEST_ADDRESS, "0.01", "10");
    expect(calls).toHaveLength(2);

    const [supply, borrow] = calls;
    expect(supply?.target).toBe(ADDRESS_BOOK["base-sepolia"].aavePool.address);
    expect(supply?.calldata.startsWith(SUPPLY)).toBe(true);
    expect(supply?.args[0]).toBe(ADDRESS_BOOK["base-sepolia"].weth.address);
    expect(supply?.args[1]).toBe(10_000_000_000_000_000n); // 0.01 WETH, 18 dec

    expect(borrow?.calldata.startsWith(BORROW)).toBe(true);
    expect(borrow?.args[0]).toBe(ADDRESS_BOOK["base-sepolia"].usdc.address);
    expect(borrow?.args[1]).toBe(10_000_000n); // $10 USDC, 6 dec
    expect(borrow?.args[2]).toBe(2n); // variable interest-rate mode
  });

  it("uses the mainnet allowlist entries when the chain is base", () => {
    const [supply] = buildSetupCalls("base", TEST_ADDRESS, "0.01", "10");
    expect(supply?.target).toBe(ADDRESS_BOOK.base.aavePool.address);
    expect(supply?.args[0]).toBe(ADDRESS_BOOK.base.weth.address);
  });
});

describe("scripts: stress-position", () => {
  it("encodes an extra borrow", () => {
    const call = buildStressCall("base-sepolia", TEST_ADDRESS, { borrowUsdc: "5" });
    expect(call.calldata.startsWith(BORROW)).toBe(true);
    expect(call.args[1]).toBe(5_000_000n);
  });

  it("encodes a collateral withdrawal", () => {
    const call = buildStressCall("base-sepolia", TEST_ADDRESS, { withdrawWeth: "0.002" });
    expect(call.calldata.startsWith(WITHDRAW)).toBe(true);
    expect(call.args[1]).toBe(2_000_000_000_000_000n);
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
