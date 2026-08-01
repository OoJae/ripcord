import { describe, expect, it } from "vitest";
import {
  baseUnitsToUsd,
  computeVelocity,
  createAaveSensor,
  createMockSensor,
  parseAccountData,
  SampleWindow,
  wadToHf,
} from "../../src/sensor/aave.js";
import {
  FIXTURE_A,
  FIXTURE_B,
  FIXTURE_C,
  FIXTURE_D,
  FIXTURE_DEGENERATE,
  MAX_UINT256,
  WAD,
} from "../fixtures/aave.js";
import { makeTestConfig, TEST_ADDRESS } from "../helpers/fakes.js";

describe("sensor: HF and decimal math", () => {
  it("parses fixture A (healthy) into exact snapshot values", () => {
    const p = parseAccountData(FIXTURE_A);
    expect(p.hfWad).toBe(2_000_000_000_000_000_000n);
    expect(p.hf).toBe(2.0);
    expect(p.hasDebt).toBe(true);
    expect(p.totalCollateralUsd).toBe(50);
    expect(p.totalDebtUsd).toBe(20);
    expect(p.liquidationThresholdBps).toBe(8000);
    expect(p.ltvBps).toBe(7500);
  });

  it("parses fixture B (act band) to exactly 1.2", () => {
    const p = parseAccountData(FIXTURE_B);
    expect(p.hf).toBe(1.2);
    expect(p.hfWad).toBe(1_200_000_000_000_000_000n);
  });

  it("maps the maxUint256 no-debt sentinel to Infinity without overflowing", () => {
    const p = parseAccountData(FIXTURE_C);
    expect(p.hasDebt).toBe(false);
    expect(p.hf).toBe(Number.POSITIVE_INFINITY);
    expect(p.hfWad).toBe(MAX_UINT256); // raw value preserved for the audit trail
    expect(wadToHf(MAX_UINT256)).toBe(Number.POSITIVE_INFINITY);
  });

  it("parses an empty account without throwing", () => {
    const p = parseAccountData(FIXTURE_D);
    expect(p.totalCollateralUsd).toBe(0);
    expect(p.totalDebtUsd).toBe(0);
    expect(p.hasDebt).toBe(false);
  });

  it("parses the degenerate zero-HF-with-debt case", () => {
    const p = parseAccountData(FIXTURE_DEGENERATE);
    expect(p.hasDebt).toBe(true);
    expect(p.hf).toBe(0);
    expect(p.hfWad).toBe(0n);
  });

  it("preserves a 1-wei HF difference exactly in hfWad", () => {
    const base = (WAD * 3n) / 2n; // 1.5
    expect(parseAccountData([0n, 1n, 0n, 8000n, 7500n, base + 1n]).hfWad).toBe(base + 1n);
    expect(parseAccountData([0n, 1n, 0n, 8000n, 7500n, base - 1n]).hfWad).toBe(base - 1n);
  });

  it("documents the float hazard that forces bigint band comparisons", () => {
    // A 1-wei difference is INVISIBLE once the wad becomes a double — which is
    // exactly why src/policy compares hfWad bigints, never snapshot.hf.
    const base = (WAD * 3n) / 2n;
    expect(Number(base + 1n) / 1e18).toBe(1.5);
    expect(Number(base) / 1e18).toBe(1.5);
    expect(base + 1n).not.toBe(base); // …but the wads differ
  });

  it("converts 8-decimal base currency exactly", () => {
    expect(baseUnitsToUsd(100_000_000_000_000n)).toBe(1_000_000);
    expect(baseUnitsToUsd(5_000_000_000n)).toBe(50);
    expect(baseUnitsToUsd(1n)).toBeCloseTo(1e-8, 12);
  });
});

describe("sensor: HF velocity", () => {
  it("computes Δ HF per minute across three samples", () => {
    const v = computeVelocity([
      { tMs: 0, hf: 1.5 },
      { tMs: 60_000, hf: 1.45 },
      { tMs: 120_000, hf: 1.38 },
    ]);
    expect(v).toBeCloseTo(-0.06, 10);
  });

  it("returns null with fewer than three samples", () => {
    expect(computeVelocity([])).toBeNull();
    expect(computeVelocity([{ tMs: 0, hf: 1.5 }])).toBeNull();
    expect(
      computeVelocity([
        { tMs: 0, hf: 1.5 },
        { tMs: 60_000, hf: 1.4 },
      ]),
    ).toBeNull();
  });

  it("ignores non-finite samples instead of propagating Infinity", () => {
    const v = computeVelocity([
      { tMs: 0, hf: Number.POSITIVE_INFINITY },
      { tMs: 60_000, hf: 1.45 },
      { tMs: 120_000, hf: 1.38 },
    ]);
    expect(v).toBeNull(); // only two finite samples remain
    expect(Number.isFinite(v ?? 0)).toBe(true);
  });

  it("returns null rather than dividing by a zero time delta", () => {
    expect(
      computeVelocity([
        { tMs: 5, hf: 1.5 },
        { tMs: 5, hf: 1.4 },
        { tMs: 5, hf: 1.3 },
      ]),
    ).toBeNull();
  });

  it("SampleWindow keeps only the most recent N samples", () => {
    const w = new SampleWindow(3);
    for (let i = 0; i < 5; i++) w.push({ tMs: i * 1000, hf: 2 - i * 0.1 });
    expect(w.samples).toHaveLength(3);
    expect(w.samples[0]?.tMs).toBe(2000);
  });
});

describe("sensor: live reads via an injected client", () => {
  it("builds a full snapshot from Aave + balance reads", async () => {
    const cfg = makeTestConfig({ MONITORED_ADDRESS: TEST_ADDRESS });
    const calls: string[] = [];
    const sensor = createAaveSensor(cfg, {
      async readContract(args) {
        calls.push(args.functionName);
        if (args.functionName === "getUserAccountData") return FIXTURE_B;
        // USDC then WETH balanceOf
        return args.address === cfg.addressBook.usdc.address
          ? 25_000_000n
          : 10_000_000_000_000_000n;
      },
    });

    const snap = await sensor.read();
    expect(calls).toContain("getUserAccountData");
    expect(snap.hf).toBe(1.2);
    expect(snap.hfWad).toBe(1_200_000_000_000_000_000n);
    expect(snap.address).toBe(TEST_ADDRESS);
    expect(snap.chain).toBe("base-sepolia");
    expect(snap.balances.usdcUsd).toBe(25);
    expect(snap.balances.collateralAmount).toBe(0.01);
    expect(snap.hfVelocityPerMin).toBeNull(); // the daemon fills this in
  });

  it("refuses to construct without a monitored address", () => {
    expect(() => createAaveSensor(makeTestConfig())).toThrow(/MONITORED_ADDRESS/);
  });
});

describe("sensor: mock sensor (zero-secret demo)", () => {
  it("descends through the bands and recovers when a defense lands", async () => {
    const s = createMockSensor();
    const readings: number[] = [];
    for (let i = 0; i < 7; i++) readings.push((await s.read()).hf);

    expect(readings[0]).toBeCloseTo(1.82, 2);
    for (let i = 1; i < readings.length; i++) {
      expect(readings[i]).toBeLessThan(readings[i - 1] as number);
    }
    expect(readings[readings.length - 1]).toBeLessThan(1.25); // reached the act band

    const before = (await s.read()).hf;
    s.applyDefense(5);
    const after = (await s.read()).hf;
    expect(after).toBeGreaterThan(before); // the rescue is arithmetically real
  });

  it("honours an explicit scenario and keeps the position consistent", async () => {
    const s = createMockSensor(["1.47", "1.21"]);
    expect((await s.read()).hf).toBeCloseTo(1.47, 4);
    const second = await s.read();
    expect(second.hf).toBeCloseTo(1.21, 4);
    expect(second.hasDebt).toBe(true);
    expect(second.totalDebtUsd).toBeGreaterThan(0);
  });
});
