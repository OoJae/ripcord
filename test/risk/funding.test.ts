/**
 * The funding ladder. These tests exist as much to pin the HONESTY of the
 * reporting as the arithmetic: capacity Ripcord can see but cannot spend must
 * never be counted as executable, because that is precisely the number an
 * operator would bet their position on.
 */

import { describe, expect, it } from "vitest";
import { assessFunding } from "../../src/risk/funding.js";
import { makeSnapshot } from "../helpers/fakes.js";

describe("assessFunding", () => {
  it("counts ONLY wallet USDC as executable today", () => {
    const f = assessFunding(makeSnapshot("1.20")); // wallet $25, no aUSDC
    expect(f.executableUsd).toBe(25);
    const wired = f.rungs.filter((r) => r.executable).map((r) => r.id);
    expect(wired).toEqual(["wallet-usdc"]);
  });

  it("sees supplied USDC but refuses to call it executable", () => {
    const s = makeSnapshot("1.20", {
      balances: {
        usdcRaw: 0n,
        usdcUsd: 0,
        collateralRaw: 0n,
        collateralAmount: 0,
        collateralSymbol: "WETH" as const,
        aUsdcRaw: 500_000_000n,
        aUsdcUsd: 500,
      },
    });
    const f = assessFunding(s);
    expect(f.executableUsd).toBe(0); // cannot spend it — repayWithATokens unwired
    expect(f.potentialUsd).toBeGreaterThanOrEqual(500);
    const atoken = f.rungs.find((r) => r.id === "atoken-usdc");
    expect(atoken?.capacityUsd).toBe(500);
    expect(atoken?.executable).toBe(false);
    expect(atoken?.detail).toMatch(/not yet wired/);
  });

  it("reports collateral headroom as the incumbents' gap, never as capacity", () => {
    // collateral $30 @ LT 80% = $24 effective, debt $20 → $4 headroom.
    const f = assessFunding(makeSnapshot("1.20"));
    const coll = f.rungs.find((r) => r.id === "collateral-swap");
    expect(coll?.capacityUsd).toBeCloseTo(4, 6);
    expect(coll?.executable).toBe(false);
    expect(coll?.detail).toMatch(/flash-loan|ParaSwapRepayAdapter/);
  });

  it("an underwater position reports zero headroom, never negative", () => {
    const s = makeSnapshot("0.90", { totalCollateralUsd: 20, totalDebtUsd: 25 });
    const coll = assessFunding(s).rungs.find((r) => r.id === "collateral-swap");
    expect(coll?.capacityUsd).toBe(0);
  });

  it("ranks the cheapest defense first — aToken repay before wallet spend", () => {
    const ids = assessFunding(makeSnapshot("1.20")).rungs.map((r) => r.id);
    expect(ids.indexOf("atoken-usdc")).toBeLessThan(ids.indexOf("wallet-usdc"));
  });
});

describe("assessFunding — reserve-floor awareness (audit #4)", () => {
  it("caps the wallet rung at (wallet − reserve floor), the dollars the Guard will actually let it spend", () => {
    // wallet $25, floor $16 → only $9 is spendable; the Guard's
    // wallet-reserve-floor rule refuses any repay that dips below $16.
    const f = assessFunding(makeSnapshot("1.20"), 16);
    expect(f.executableUsd).toBe(9);
    const wallet = f.rungs.find((r) => r.id === "wallet-usdc");
    expect(wallet?.capacityUsd).toBe(9);
    expect(wallet?.detail).toContain("reserve floor");
  });

  it("never reports negative capacity when the floor exceeds the balance", () => {
    const f = assessFunding(makeSnapshot("1.20"), 100);
    expect(f.executableUsd).toBe(0);
  });

  it("a zero / omitted floor is unchanged — full wallet is spendable", () => {
    expect(assessFunding(makeSnapshot("1.20"), 0).executableUsd).toBe(25);
    expect(assessFunding(makeSnapshot("1.20")).executableUsd).toBe(25);
  });
});
