// ============================================================
// NEXUS — Analytics Dashboard
// Aggregates session history into improvement metrics
// ============================================================

import chalk from "chalk";
import { loadAllJournalEntries } from "./journal";
import { ANALYSIS_RULES_PATH } from "./utils";
import * as fs from "fs";
import type { JournalEntry, TradingSetup } from "./types";

// ── Setup Outcome Types ─────────────────────────────────────

export type SetupOutcome = "TARGET_HIT" | "STOPPED_OUT" | "OPEN" | "INCOMPLETE";

export interface ResolvedSetup {
  sessionNumber: number;
  instrument: string;
  direction: string;
  entry: number;
  stop: number;
  target: number;
  RR: number;
  outcome: SetupOutcome;
  nextPrice: number | null;
}

// ── Core Analytics ──────────────────────────────────────────

/**
 * Resolves setup outcomes by comparing each session's setups
 * against the NEXT session's market prices.
 */
export function resolveAllSetups(entries: JournalEntry[]): ResolvedSetup[] {
  const resolved: ResolvedSetup[] = [];

  for (let i = 0; i < entries.length - 1; i++) {
    const current = entries[i];
    const next = entries[i + 1];
    const setups = current.fullAnalysis?.setups ?? [];
    const nextSnapshots = next.fullAnalysis?.marketSnapshots ?? [];

    // Build price lookup from next session
    const priceMap: Record<string, number> = {};
    for (const snap of nextSnapshots) {
      priceMap[snap.symbol] = snap.price;
      priceMap[snap.name] = snap.price;
      priceMap[snap.name.toLowerCase()] = snap.price;
    }

    for (const setup of setups) {
      if (setup.entry == null || setup.stop == null || setup.target == null) {
        continue; // skip incomplete setups
      }

      const nextPrice = priceMap[setup.instrument]
        ?? priceMap[setup.instrument.toLowerCase()]
        ?? null;

      let outcome: SetupOutcome = "INCOMPLETE";
      if (nextPrice !== null) {
        if (setup.direction === "bullish") {
          if (nextPrice <= setup.stop)        outcome = "STOPPED_OUT";
          else if (nextPrice >= setup.target) outcome = "TARGET_HIT";
          else                                outcome = "OPEN";
        } else if (setup.direction === "bearish") {
          if (nextPrice >= setup.stop)        outcome = "STOPPED_OUT";
          else if (nextPrice <= setup.target) outcome = "TARGET_HIT";
          else                                outcome = "OPEN";
        }
      }

      resolved.push({
        sessionNumber: current.sessionNumber,
        instrument: setup.instrument,
        direction: setup.direction ?? "unknown",
        entry: setup.entry,
        stop: setup.stop,
        target: setup.target,
        RR: setup.RR ?? 0,
        outcome,
        nextPrice,
      });
    }
  }

  return resolved;
}

export interface WindowStats {
  label: string;
  sessions: number;
  totalSetups: number;
  resolved: number;
  targetHit: number;
  stoppedOut: number;
  open: number;
  hitRate: number | null;    // targetHit / (targetHit + stoppedOut), null if no resolved
  avgConfidence: number;
  avgSetups: number;
  ruleChanges: number;
  avgRR: number | null;
}

export function computeWindowStats(entries: JournalEntry[], allSetups: ResolvedSetup[], label: string): WindowStats {
  const sessionNumbers = new Set(entries.map(e => e.sessionNumber));
  const setups = allSetups.filter(s => sessionNumbers.has(s.sessionNumber));

  const targetHit = setups.filter(s => s.outcome === "TARGET_HIT").length;
  const stoppedOut = setups.filter(s => s.outcome === "STOPPED_OUT").length;
  const open = setups.filter(s => s.outcome === "OPEN").length;
  const resolved = targetHit + stoppedOut;

  const confidences = entries
    .map(e => e.fullAnalysis?.confidence)
    .filter((c): c is number => typeof c === "number");

  const rrs = setups.filter(s => s.RR > 0).map(s => s.RR);

  let ruleChanges = 0;
  for (const e of entries) {
    ruleChanges += e.reflection?.ruleUpdates?.length ?? 0;
  }

  return {
    label,
    sessions: entries.length,
    totalSetups: setups.length,
    resolved,
    targetHit,
    stoppedOut,
    open,
    hitRate: resolved > 0 ? targetHit / resolved : null,
    avgConfidence: confidences.length > 0
      ? confidences.reduce((a, b) => a + b, 0) / confidences.length
      : 0,
    avgSetups: entries.length > 0 ? setups.length / entries.length : 0,
    avgRR: rrs.length > 0 ? rrs.reduce((a, b) => a + b, 0) / rrs.length : null,
    ruleChanges,
  };
}

// ── Confidence Calibration ──────────────────────────────────

export interface CalibrationBucket {
  range: string;
  sessions: number;
  avgConfidence: number;
  hitRate: number | null;
  delta: number | null; // hitRate - avgConfidence/100
}

export function computeCalibration(entries: JournalEntry[], allSetups: ResolvedSetup[]): CalibrationBucket[] {
  const buckets: { min: number; max: number; label: string }[] = [
    { min: 0,  max: 30,  label: " 0-30%" },
    { min: 30, max: 50,  label: "30-50%" },
    { min: 50, max: 70,  label: "50-70%" },
    { min: 70, max: 85,  label: "70-85%" },
    { min: 85, max: 101, label: "85-100%" },
  ];

  return buckets.map(({ min, max, label }) => {
    const bucketEntries = entries.filter(e => {
      const c = e.fullAnalysis?.confidence;
      return typeof c === "number" && c >= min && c < max;
    });

    const sessionNums = new Set(bucketEntries.map(e => e.sessionNumber));
    const setups = allSetups.filter(s => sessionNums.has(s.sessionNumber));
    const hits = setups.filter(s => s.outcome === "TARGET_HIT").length;
    const stopped = setups.filter(s => s.outcome === "STOPPED_OUT").length;
    const resolved = hits + stopped;

    const confidences = bucketEntries
      .map(e => e.fullAnalysis?.confidence)
      .filter((c): c is number => typeof c === "number");

    const avgConf = confidences.length > 0
      ? confidences.reduce((a, b) => a + b, 0) / confidences.length
      : 0;

    const hitRate = resolved > 0 ? hits / resolved : null;

    return {
      range: label,
      sessions: bucketEntries.length,
      avgConfidence: avgConf,
      hitRate,
      delta: hitRate !== null ? hitRate - avgConf / 100 : null,
    };
  });
}

// ── Bias Accuracy ───────────────────────────────────────────

export interface BiasRecord {
  bias: string;
  count: number;
  hitRate: number | null;
}

export function computeBiasAccuracy(entries: JournalEntry[], allSetups: ResolvedSetup[]): BiasRecord[] {
  const biasTypes = ["bullish", "bearish", "neutral", "mixed"];
  return biasTypes.map(bias => {
    const matching = entries.filter(e => e.fullAnalysis?.bias?.overall === bias);
    const sessionNums = new Set(matching.map(e => e.sessionNumber));
    const setups = allSetups.filter(s => sessionNums.has(s.sessionNumber));
    const hits = setups.filter(s => s.outcome === "TARGET_HIT").length;
    const stopped = setups.filter(s => s.outcome === "STOPPED_OUT").length;
    const resolved = hits + stopped;

    return {
      bias,
      count: matching.length,
      hitRate: resolved > 0 ? hits / resolved : null,
    };
  }).filter(b => b.count > 0);
}

// ── Evolution Velocity ──────────────────────────────────────

export interface EvolutionStats {
  totalRuleChanges: number;
  totalNewRules: number;
  totalModified: number;
  totalRemoved: number;
  currentRuleCount: number;
  currentVersion: number;
  avgChangesPerSession: number;
  longestStagnation: number;
  cognitivePatterns: { bias: string; count: number }[];
}

export function computeEvolution(entries: JournalEntry[]): EvolutionStats {
  let totalNew = 0;
  let totalMod = 0;
  let totalRem = 0;
  let longestStagnation = 0;
  let currentStreak = 0;

  const biasCount: Record<string, number> = {};

  for (const e of entries) {
    const updates = e.reflection?.ruleUpdates ?? [];
    if (updates.length === 0) {
      currentStreak++;
      longestStagnation = Math.max(longestStagnation, currentStreak);
    } else {
      currentStreak = 0;
    }

    for (const u of updates) {
      if (u.type === "add") totalNew++;
      else if (u.type === "modify") totalMod++;
      else if (u.type === "remove") totalRem++;
    }

    for (const bias of e.reflection?.cognitiveBiases ?? []) {
      const key = bias.toLowerCase().trim();
      biasCount[key] = (biasCount[key] ?? 0) + 1;
    }
  }

  const cognitivePatterns = Object.entries(biasCount)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([bias, count]) => ({ bias, count }));

  let currentRuleCount = 0;
  let currentVersion = 1;
  try {
    if (fs.existsSync(ANALYSIS_RULES_PATH)) {
      const rules = JSON.parse(fs.readFileSync(ANALYSIS_RULES_PATH, "utf-8"));
      currentRuleCount = rules.rules?.length ?? 0;
      currentVersion = rules.version ?? 1;
    }
  } catch { /* ignore */ }

  const totalChanges = totalNew + totalMod + totalRem;

  return {
    totalRuleChanges: totalChanges,
    totalNewRules: totalNew,
    totalModified: totalMod,
    totalRemoved: totalRem,
    currentRuleCount,
    currentVersion,
    avgChangesPerSession: entries.length > 0 ? totalChanges / entries.length : 0,
    longestStagnation,
    cognitivePatterns,
  };
}

// ── Failure Analysis ────────────────────────────────────────

interface FailureStats {
  total: number;
  byPhase: Record<string, number>;
  recentTrend: string; // "improving" | "stable" | "worsening"
}

function computeFailureStats(): FailureStats {
  const failuresPath = require("path").join(process.cwd(), "memory", "failures.json");
  let failures: any[] = [];
  try {
    if (fs.existsSync(failuresPath)) {
      failures = JSON.parse(fs.readFileSync(failuresPath, "utf-8"));
    }
  } catch { /* ignore */ }

  const byPhase: Record<string, number> = {};
  for (const f of failures) {
    const phase = f.phase ?? "unknown";
    byPhase[phase] = (byPhase[phase] ?? 0) + 1;
  }

  // Trend: compare first half vs second half failure counts
  let trend = "stable";
  if (failures.length >= 4) {
    const mid = Math.floor(failures.length / 2);
    const firstHalf = failures.slice(0, mid).length;
    const secondHalf = failures.slice(mid).length;
    if (secondHalf < firstHalf * 0.7) trend = "improving";
    else if (secondHalf > firstHalf * 1.3) trend = "worsening";
  }

  return { total: failures.length, byPhase, recentTrend: trend };
}

// ── Rendering ───────────────────────────────────────────────

function pct(n: number | null): string {
  if (n === null) return chalk.dim("n/a");
  return `${(n * 100).toFixed(1)}%`;
}

function renderWindowStats(stats: WindowStats): void {
  const hitColor = stats.hitRate !== null && stats.hitRate >= 0.5 ? chalk.green : chalk.red;

  console.log(chalk.bold(`  ${stats.label}`));
  console.log(chalk.dim(`    Sessions: ${stats.sessions}  |  Setups: ${stats.totalSetups}  |  Resolved: ${stats.resolved}`));
  console.log(
    `    Hit rate: ${stats.hitRate !== null ? hitColor(pct(stats.hitRate)) : chalk.dim("n/a")}` +
    chalk.dim(`  (${stats.targetHit} hits, ${stats.stoppedOut} stops, ${stats.open} open)`)
  );
  console.log(
    `    Avg confidence: ${chalk.cyan(stats.avgConfidence.toFixed(1) + "%")}` +
    `  |  Avg setups/session: ${chalk.cyan(stats.avgSetups.toFixed(1))}` +
    `  |  Avg R:R: ${stats.avgRR !== null ? chalk.cyan(stats.avgRR.toFixed(2)) : chalk.dim("n/a")}`
  );
  console.log(`    Rule changes: ${chalk.yellow(String(stats.ruleChanges))}`);
}

function renderSparkline(values: number[], width: number = 30): string {
  if (values.length === 0) return "";
  const blocks = " ▁▂▃▄▅▆▇█";
  const min = Math.min(...values);
  const max = Math.max(...values);
  const range = max - min || 1;

  // Sample down to width if needed
  const sampled: number[] = [];
  for (let i = 0; i < width; i++) {
    const idx = Math.floor(i * values.length / width);
    sampled.push(values[idx]);
  }

  return sampled.map(v => {
    const idx = Math.round(((v - min) / range) * (blocks.length - 1));
    return blocks[idx];
  }).join("");
}

// ── Analytics Summary for AXIOM ──────────────────────────────

export function buildAnalyticsSummary(entries: JournalEntry[]): string {
  if (entries.length < 5) return "";

  const allSetups = resolveAllSetups(entries);
  const overall = computeWindowStats(entries, allSetups, "all");
  const calibration = computeCalibration(entries, allSetups).filter(b => b.sessions > 0);
  const biasStats = computeBiasAccuracy(entries, allSetups);
  const evo = computeEvolution(entries);

  const lines: string[] = ["### Your performance analytics (from analytics dashboard):"];

  // Hit rate
  if (overall.hitRate !== null) {
    lines.push(`- Overall setup hit rate: ${(overall.hitRate * 100).toFixed(1)}% (${overall.targetHit} hits, ${overall.stoppedOut} stops, ${overall.open} still open)`);
  }

  // Improvement trend
  if (entries.length >= 10) {
    const mid = Math.floor(entries.length / 2);
    const first = computeWindowStats(entries.slice(0, mid), allSetups, "first");
    const second = computeWindowStats(entries.slice(mid), allSetups, "second");
    if (first.hitRate !== null && second.hitRate !== null) {
      const delta = second.hitRate - first.hitRate;
      const dir = delta > 0.05 ? "IMPROVING" : delta < -0.05 ? "DECLINING" : "STABLE";
      lines.push(`- Trend: ${dir} — first half ${(first.hitRate * 100).toFixed(0)}% → second half ${(second.hitRate * 100).toFixed(0)}%`);
    }
  }

  // Calibration
  const calLines = calibration
    .filter(b => b.hitRate !== null)
    .map(b => `  ${b.range}: you say ${b.avgConfidence.toFixed(0)}% confident → actual hit rate ${(b.hitRate! * 100).toFixed(0)}%`);
  if (calLines.length > 0) {
    lines.push("- Confidence calibration (are you overconfident or underconfident?):");
    lines.push(...calLines);
  }

  // Bias accuracy
  const biasLines = biasStats
    .filter(b => b.count >= 3)
    .map(b => `  ${b.bias}: ${b.count} sessions, setup hit rate ${b.hitRate !== null ? (b.hitRate * 100).toFixed(0) + "%" : "n/a"}`);
  if (biasLines.length > 0) {
    lines.push("- Bias accuracy (which bias calls produce the best setups?):");
    lines.push(...biasLines);
  }

  // Evolution
  lines.push(`- Evolution: ${evo.totalRuleChanges} total rule changes (${evo.totalNewRules} added, ${evo.totalModified} modified, ${evo.totalRemoved} removed)`);
  if (evo.totalRemoved === 0 && evo.totalRuleChanges > 0) {
    lines.push("- WARNING: You have NEVER removed a rule. Consider whether all rules are still earning their place.");
  }

  lines.push("Use these metrics to ground your reflection in real outcomes, not assumptions.");

  return lines.join("\n");
}

// ── Main Command ────────────────────────────────────────────

export function runAnalytics(options: { window?: string }): void {
  const entries = loadAllJournalEntries();

  if (entries.length === 0) {
    console.log(chalk.dim("\n  No sessions yet. Run a session first.\n"));
    return;
  }

  const allSetups = resolveAllSetups(entries);
  const windowSize = parseInt(options.window ?? "0", 10);

  console.log(chalk.bold.yellow("\n  ═══════════════════════════════════════════"));
  console.log(chalk.bold.yellow("  NEXUS ANALYTICS DASHBOARD"));
  console.log(chalk.bold.yellow("  ═══════════════════════════════════════════\n"));

  // ── 1. Overall Stats ─────────────────────────────────────
  const overall = computeWindowStats(entries, allSetups, "ALL TIME");
  renderWindowStats(overall);

  // ── 2. Rolling Windows ────────────────────────────────────
  if (entries.length >= 10) {
    console.log(chalk.bold.yellow("\n  ── IMPROVEMENT TREND ──\n"));

    // Split into halves
    const mid = Math.floor(entries.length / 2);
    const firstHalf = entries.slice(0, mid);
    const secondHalf = entries.slice(mid);
    const firstStats = computeWindowStats(firstHalf, allSetups, `First half (sessions 1-${mid})`);
    const secondStats = computeWindowStats(secondHalf, allSetups, `Second half (sessions ${mid + 1}-${entries.length})`);

    renderWindowStats(firstStats);
    console.log("");
    renderWindowStats(secondStats);

    // Improvement verdict
    console.log("");
    if (firstStats.hitRate !== null && secondStats.hitRate !== null) {
      const delta = secondStats.hitRate - firstStats.hitRate;
      const arrow = delta > 0.05 ? chalk.green("IMPROVING ↑") :
                    delta < -0.05 ? chalk.red("DECLINING ↓") :
                    chalk.yellow("STABLE →");
      console.log(`  Setup accuracy: ${arrow}  (${delta > 0 ? "+" : ""}${(delta * 100).toFixed(1)}pp)`);
    }

    if (secondStats.avgConfidence !== firstStats.avgConfidence) {
      const confDelta = secondStats.avgConfidence - firstStats.avgConfidence;
      const confArrow = confDelta > 3 ? chalk.green("↑") :
                        confDelta < -3 ? chalk.red("↓") :
                        chalk.yellow("→");
      console.log(`  Confidence trend: ${confArrow}  (${confDelta > 0 ? "+" : ""}${confDelta.toFixed(1)}pp)`);
    }
  }

  // ── 3. Custom Window ──────────────────────────────────────
  if (windowSize > 0 && entries.length > windowSize) {
    console.log(chalk.bold.yellow(`\n  ── LAST ${windowSize} SESSIONS ──\n`));
    const windowed = entries.slice(-windowSize);
    const windowStats = computeWindowStats(windowed, allSetups, `Last ${windowSize} sessions`);
    renderWindowStats(windowStats);
  }

  // ── 4. Confidence Calibration ─────────────────────────────
  console.log(chalk.bold.yellow("\n  ── CONFIDENCE CALIBRATION ──\n"));
  console.log(chalk.dim("  When NEXUS says X% confidence, how often do setups actually hit?\n"));

  const calibration = computeCalibration(entries, allSetups);
  console.log(chalk.dim("  Range     Sessions  Avg Conf  Hit Rate  Delta"));
  for (const b of calibration) {
    if (b.sessions === 0) continue;
    const deltaStr = b.delta !== null
      ? (b.delta > 0.1 ? chalk.green(`+${(b.delta * 100).toFixed(0)}pp`) :
         b.delta < -0.1 ? chalk.red(`${(b.delta * 100).toFixed(0)}pp`) :
         chalk.dim(`${(b.delta * 100).toFixed(0)}pp`))
      : chalk.dim("n/a");

    console.log(
      `  ${b.range}  ` +
      `${String(b.sessions).padStart(8)}  ` +
      `${b.avgConfidence.toFixed(0).padStart(8)}%  ` +
      `${pct(b.hitRate).padStart(8)}  ` +
      `${deltaStr}`
    );
  }

  if (calibration.every(b => b.hitRate === null)) {
    console.log(chalk.dim("  Not enough resolved setups for calibration data yet."));
  }

  // ── 5. Bias Accuracy ──────────────────────────────────────
  console.log(chalk.bold.yellow("\n  ── BIAS ACCURACY ──\n"));

  const biasStats = computeBiasAccuracy(entries, allSetups);
  for (const b of biasStats) {
    const hitStr = b.hitRate !== null ? pct(b.hitRate) : chalk.dim("n/a");
    console.log(`  ${b.bias.padEnd(8)} — ${String(b.count).padStart(3)} sessions — setup hit rate: ${hitStr}`);
  }

  // ── 6. Confidence Sparkline ───────────────────────────────
  const confidences = entries
    .map(e => e.fullAnalysis?.confidence)
    .filter((c): c is number => typeof c === "number");

  if (confidences.length >= 5) {
    console.log(chalk.bold.yellow("\n  ── CONFIDENCE OVER TIME ──\n"));
    console.log(`  ${chalk.dim("low")} ${renderSparkline(confidences, 50)} ${chalk.dim("high")}`);
    console.log(chalk.dim(`  ${confidences[0]}% → ${confidences[confidences.length - 1]}%  (${confidences.length} sessions)`));
  }

  // ── 7. Evolution Stats ────────────────────────────────────
  console.log(chalk.bold.yellow("\n  ── EVOLUTION ──\n"));
  const evo = computeEvolution(entries);
  console.log(`  Rules: ${chalk.cyan(String(evo.currentRuleCount))} (v${evo.currentVersion})`);
  console.log(`  Total changes: ${chalk.yellow(String(evo.totalRuleChanges))} (${evo.totalNewRules} added, ${evo.totalModified} modified, ${evo.totalRemoved} removed)`);
  console.log(`  Avg changes/session: ${chalk.cyan(evo.avgChangesPerSession.toFixed(2))}`);
  console.log(`  Longest stagnation: ${evo.longestStagnation > 3 ? chalk.red(String(evo.longestStagnation)) : chalk.green(String(evo.longestStagnation))} sessions`);

  if (evo.cognitivePatterns.length > 0) {
    console.log(chalk.dim("\n  Top cognitive biases detected:"));
    for (const p of evo.cognitivePatterns) {
      console.log(chalk.dim(`    ${p.count}x `) + chalk.white(p.bias));
    }
  }

  // ── 8. Failure Health ─────────────────────────────────────
  const failures = computeFailureStats();
  if (failures.total > 0) {
    console.log(chalk.bold.yellow("\n  ── STABILITY ──\n"));
    console.log(`  Total failures: ${chalk.yellow(String(failures.total))}`);
    for (const [phase, count] of Object.entries(failures.byPhase)) {
      console.log(chalk.dim(`    ${phase}: ${count}`));
    }
    const trendColor = failures.recentTrend === "improving" ? chalk.green :
                       failures.recentTrend === "worsening" ? chalk.red : chalk.yellow;
    console.log(`  Trend: ${trendColor(failures.recentTrend)}`);
  }

  // ── 9. Verdict ────────────────────────────────────────────
  console.log(chalk.bold.yellow("\n  ═══════════════════════════════════════════\n"));

  const signals: string[] = [];
  if (overall.hitRate !== null) {
    signals.push(overall.hitRate >= 0.5
      ? chalk.green(`Hit rate ${pct(overall.hitRate)} — setups are profitable`)
      : chalk.red(`Hit rate ${pct(overall.hitRate)} — setups need work`));
  }
  if (evo.avgChangesPerSession > 0.5) {
    signals.push(chalk.green("Active evolution — rules changing regularly"));
  } else if (evo.avgChangesPerSession < 0.1) {
    signals.push(chalk.red("Stagnant — very few rule changes"));
  }
  if (failures.recentTrend === "improving") {
    signals.push(chalk.green("Stability improving — fewer recent failures"));
  } else if (failures.recentTrend === "worsening") {
    signals.push(chalk.red("Stability declining — more recent failures"));
  }

  if (signals.length > 0) {
    for (const s of signals) console.log(`  ${s}`);
  } else {
    console.log(chalk.dim("  Not enough data for a verdict yet. Keep running sessions!"));
  }

  console.log("");
}
