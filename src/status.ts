/**
 * `pnpm status` — current HF, recent decisions, recent runs, spend vs cap.
 */

import { getConfig } from "./config.js";
import { createAaveSensor } from "./sensor/aave.js";
import { openDb } from "./state/db.js";

function fmtTime(ms: number): string {
  return new Date(ms).toISOString().replace("T", " ").slice(0, 19);
}

function pad(s: string, w: number): string {
  return s.length >= w ? s.slice(0, w) : s + " ".repeat(w - s.length);
}

async function main(): Promise<void> {
  const cfg = await getConfig();
  const db = openDb(cfg.dbPath);

  console.log("🪂 RIPCORD status");
  console.log(
    `  chain: ${cfg.chain} · DRY_RUN: ${cfg.dryRun ? "ON" : "off"} · ARM: ${cfg.armed ? "1" : "0"} · caps $${cfg.caps.maxTxUsd}/tx $${cfg.caps.dailyCapUsd}/24h`,
  );
  console.log(
    `  reads: ${cfg.capabilities.chainReads ? "LIVE" : "mock"} · brain: ${cfg.capabilities.llm ? cfg.model : "heuristic"} · executor: ${cfg.capabilities.keeperhub ? "KeeperHub" : "mock"}`,
  );

  if (cfg.capabilities.chainReads) {
    try {
      const snap = await createAaveSensor(cfg).read();
      console.log(
        `  current HF: ${snap.hasDebt ? snap.hf.toFixed(4) : "∞ (no debt)"} · collateral $${snap.totalCollateralUsd.toFixed(2)} · debt $${snap.totalDebtUsd.toFixed(2)}`,
      );
    } catch (err) {
      console.log(`  current HF: read failed (${String(err)})`);
    }
  }

  const decisions = db.recentDecisions(10);
  if (decisions.length === 0) {
    console.log("\n  no decisions recorded yet — run pnpm dev");
  } else {
    const last = decisions[0];
    if (last) {
      console.log(`  last observed: HF ${last.hf === null ? "?" : last.hf.toFixed(4)} [${last.band}] at ${fmtTime(last.createdAtMs)}`);
    }
    const lastDefense = db.lastDefenseAt();
    if (lastDefense !== null) {
      const elapsed = Math.floor((Date.now() - lastDefense) / 1000);
      console.log(
        `  last defense: ${fmtTime(lastDefense)} (${elapsed}s ago; cooldown ${cfg.thresholds.cooldownSec}s)`,
      );
    }

    console.log(`\n  recent decisions`);
    console.log(
      `  ${pad("time (UTC)", 20)} ${pad("band", 8)} ${pad("hf", 8)} ${pad("guard", 8)} ${pad("status", 16)}`,
    );
    for (const d of decisions) {
      console.log(
        `  ${pad(fmtTime(d.createdAtMs), 20)} ${pad(d.band, 8)} ${pad(Number.isFinite(d.hf) ? d.hf.toFixed(4) : "∞", 8)} ${pad(d.guardDecision ?? "-", 8)} ${pad(d.status, 16)}`,
      );
    }

    const executions = db.recentExecutions(5);
    if (executions.length > 0) {
      console.log(`\n  recent executions`);
      console.log(
        `  ${pad("time (UTC)", 20)} ${pad("action", 18)} ${pad("$", 8)} ${pad("status", 10)} tx`,
      );
      for (const e of executions) {
        console.log(
          `  ${pad(fmtTime(e.requestedAtMs), 20)} ${pad(`${e.action} ${e.assetSymbol}`, 18)} ${pad((e.amountUsdCents / 100).toFixed(2), 8)} ${pad(e.status, 10)} ${e.txHash ?? "-"}`,
        );
      }
    }

    const spentCents = db.spentCentsSince(Date.now() - 86_400_000);
    console.log(
      `\n  spent (rolling 24h): $${(spentCents / 100).toFixed(2)} / $${cfg.caps.dailyCapUsd.toFixed(2)}`,
    );
  }

  db.close();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
