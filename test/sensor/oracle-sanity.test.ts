/**
 * Oracle-sanity gate: the deterministic half.
 *
 * The 2026 headline liquidations (Moonwell's $1.12 cbETH print, Aave's CAPO
 * glitch) were single-block oracle mispricings. This gate cannot out-race a
 * block — its job is to refuse to ACT on corrupted pricing. The failure
 * posture is asymmetric by design and pinned here:
 *   divergent   → block (a defense sized from a corrupted price is a hazard)
 *   unavailable → proceed with warning (the reference must never brick a rescue)
 */

import { describe, expect, it } from "vitest";
import {
  evaluateOracleSanity,
  REFERENCE_MAX_STALENESS_MS,
} from "../../src/sensor/oracle-sanity.js";

const NOW = 1_753_920_000_000;
const FRESH = NOW - 60_000;

const WETH_BAND = { refRatioMin: 0.95, refRatioMax: 1.05 };
const CBETH_BAND = { refRatioMin: 0.8, refRatioMax: 1.4 };

function evalWith(aave: number, ref: number, band = WETH_BAND, updatedAt = FRESH) {
  return evaluateOracleSanity({
    aaveCollateralUsd: aave,
    referenceEthUsd: ref,
    referenceUpdatedAtMs: updatedAt,
    nowMs: NOW,
    ...band,
  });
}

describe("oracle-sanity: verdicts", () => {
  it("agreement passes (live figures from 2026-08-02: Aave 1870.56 vs Chainlink 1874.63)", () => {
    const r = evalWith(1870.56, 1874.63);
    expect(r.status).toBe("ok");
    expect(r.ratio).toBeCloseTo(0.9978, 3);
  });

  it("REPLAYS MOONWELL: cbETH printed at $1.12 against ~$1.9k ETH → divergent", () => {
    // The Feb 2026 incident that liquidated 181 borrowers. Ratio ≈ 0.0006,
    // four orders of magnitude below even the wide cbETH floor.
    const r = evalWith(1.12, 1874.63, CBETH_BAND);
    expect(r.status).toBe("divergent");
    expect(r.detail).toMatch(/ORACLE ANOMALY/);
  });

  it("a legitimate cbETH staking premium is NOT an anomaly", () => {
    expect(evalWith(2043.0, 1874.63, CBETH_BAND).status).toBe("ok"); // ratio 1.09
  });

  it("WETH band edges are exact", () => {
    expect(evalWith(1874.63 * 0.95, 1874.63).status).toBe("ok"); // exactly min
    expect(evalWith(1874.63 * 0.9499, 1874.63).status).toBe("divergent");
    expect(evalWith(1874.63 * 1.05, 1874.63).status).toBe("ok"); // exactly max
    expect(evalWith(1874.63 * 1.0501, 1874.63).status).toBe("divergent");
  });

  it("an upward-lying Aave oracle is also caught (inflated collateral hides risk)", () => {
    const r = evalWith(5000, 1874.63);
    expect(r.status).toBe("divergent");
  });

  it("stale reference → unavailable, never a verdict from old data", () => {
    const stale = NOW - REFERENCE_MAX_STALENESS_MS - 1;
    const r = evalWith(1.12, 1874.63, CBETH_BAND, stale);
    expect(r.status).toBe("unavailable");
    expect(r.detail).toMatch(/proceeding on the Aave oracle alone/);
  });

  it("garbage reference (zero/NaN) → unavailable", () => {
    expect(evalWith(1870, 0).status).toBe("unavailable");
    expect(evalWith(1870, Number.NaN).status).toBe("unavailable");
  });

  it("a non-positive AAVE price is divergent, not unavailable — that IS the anomaly", () => {
    expect(evalWith(0, 1874.63).status).toBe("divergent");
    expect(evalWith(-5, 1874.63).status).toBe("divergent");
  });
});

// ---------------------------------------------------------------------------
// The LIVE checker (audit #5/#8): createOracleSanityChecker turns on-chain
// reads into the pure verdict above. It was previously untested, so a wrong
// decimal (1e8 vs 1e18), a swapped latestRoundData tuple index, or a broken
// catch could silently disable the whole gate while every test stayed green.

import { ADDRESS_BOOK } from "../../src/config.js";
import { createOracleSanityChecker } from "../../src/sensor/oracle-sanity.js";
import { makeTestConfig } from "../helpers/fakes.js";

const baseCfg = makeTestConfig({}, { chain: "base", addressBook: ADDRESS_BOOK.base });

/**
 * A fake viem client dispatching readContract by functionName:
 *   ADDRESSES_PROVIDER → provider addr · getPriceOracle → oracle addr
 *   getAssetPrice → aaveRaw (1e8) · latestRoundData → 5-tuple [id,answer,started,updatedAt,answeredIn]
 */
function fakeClient(opts: {
  aaveRaw: bigint;
  answer: bigint;
  updatedAtSec: number;
  throwOn?: string;
}): Parameters<typeof createOracleSanityChecker>[1] {
  return {
    async readContract({ functionName }: { functionName: string }) {
      if (opts.throwOn && functionName === opts.throwOn) {
        // Embed the CONFIGURED rpcUrl (what viem would leak) so the scrub
        // assertion is meaningful — scrubRpcUrl removes that exact string.
        throw new Error(`RPC boom — URL: ${baseCfg.rpcUrl}`);
      }
      switch (functionName) {
        case "ADDRESSES_PROVIDER":
          return "0x1111111111111111111111111111111111111111";
        case "getPriceOracle":
          return "0x2222222222222222222222222222222222222222";
        case "getAssetPrice":
          return opts.aaveRaw;
        case "latestRoundData":
          return [1n, opts.answer, 0n, BigInt(opts.updatedAtSec), 1n];
        default:
          throw new Error(`unexpected functionName ${functionName}`);
      }
    },
  } as unknown as Parameters<typeof createOracleSanityChecker>[1];
}

describe("createOracleSanityChecker — live read/scale chain", () => {
  const nowMs = 1_753_920_000_000;
  const freshSec = Math.floor(nowMs / 1000) - 60;

  it("OK: scales both prices by 1e8 and reads answer from tuple[1], updatedAt from tuple[3]", async () => {
    const checker = createOracleSanityChecker(
      baseCfg,
      fakeClient({ aaveRaw: 187_000_000_000n, answer: 187_400_000_000n, updatedAtSec: freshSec }),
      () => nowMs,
    );
    const r = await checker.check();
    expect(r.status).toBe("ok");
    // /1e8, not /1e18 — a decimal-place mutation would blow these up by 1e10.
    expect(r.aaveCollateralUsd).toBeCloseTo(1870, 0);
    expect(r.referenceEthUsd).toBeCloseTo(1874, 0);
    expect(r.ratio).toBeCloseTo(0.9979, 3);
  });

  it("DIVERGENT: a Moonwell-class $1.12 print against ~$1874 blocks", async () => {
    const checker = createOracleSanityChecker(
      baseCfg,
      fakeClient({ aaveRaw: 112_000_000n, answer: 187_400_000_000n, updatedAtSec: freshSec }),
      () => nowMs,
    );
    expect((await checker.check()).status).toBe("divergent");
  });

  it("UNAVAILABLE: a stale reference (updatedAt beyond the heartbeat) proceeds, does not block", async () => {
    const staleSec = Math.floor((nowMs - REFERENCE_MAX_STALENESS_MS - 60_000) / 1000);
    const checker = createOracleSanityChecker(
      baseCfg,
      fakeClient({ aaveRaw: 187_000_000_000n, answer: 187_400_000_000n, updatedAtSec: staleSec }),
      () => nowMs,
    );
    // proves seconds→ms conversion: a raw-seconds compare would read as fresh.
    expect((await checker.check()).status).toBe("unavailable");
  });

  it("UNAVAILABLE: a negative Chainlink answer is treated as unusable, not as a price", async () => {
    const checker = createOracleSanityChecker(
      baseCfg,
      fakeClient({ aaveRaw: 187_000_000_000n, answer: -1n, updatedAtSec: freshSec }),
      () => nowMs,
    );
    expect((await checker.check()).status).toBe("unavailable");
  });

  it("a read failure degrades to UNAVAILABLE (never a false OK, never a crash) and scrubs the RPC key", async () => {
    // A key-bearing RPC URL — what a real provider endpoint looks like. The
    // scrub must strip the key-bearing path out of the error before it reaches
    // logs / SQLite / the Critic prompt.
    const keyedCfg = makeTestConfig(
      { BASE_SEPOLIA_RPC_URL: "https://rpc.example.com/v2/SECRETKEY111" },
      { chain: "base", addressBook: ADDRESS_BOOK.base },
    );
    const checker = createOracleSanityChecker(
      keyedCfg,
      {
        async readContract() {
          throw new Error(`RPC boom — URL: ${keyedCfg.rpcUrl}`);
        },
      } as unknown as Parameters<typeof createOracleSanityChecker>[1],
      () => nowMs,
    );
    const r = await checker.check();
    expect(r.status).toBe("unavailable");
    expect(r.detail).not.toContain("SECRETKEY111");
  });
});
