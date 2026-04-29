// ============================================================
// NEXUS — Agent Orchestrator
// Runs the full ORACLE → AXIOM → JOURNAL cycle
// ============================================================

import Anthropic  from "@anthropic-ai/sdk";
import chalk      from "chalk";
import ora        from "ora";
import * as fs    from "fs";
import * as path  from "path";
import { execSync } from "child_process";
import { format } from "date-fns";
import { fetchAllMarkets, printMarketsTable }                     from "./markets";
import { fetchCryptoMarkets }                                     from "./crypto-markets";
import { fetchMacroSnapshot, formatMacroForPrompt, printMacroSummary } from "./macro";
import { fetchCommunityIssues, formatIssuesForPrompt }             from "./issues";
import { fetchOpenSelfTasks, formatSelfTasksForPrompt, setCachedOpenTasks, createSelfTask } from "./self-tasks";
import { runOracleAnalysis }                                       from "./oracle";
import { runAxiomReflection, initMemoryIfNeeded }                  from "./axiom";
import { runForge, formatForgeResults }                             from "./forge";
import {
  buildJournalEntry,
  writeJournalMarkdown,
  updateGithubPages,
  updateReadmeSessionsTable,
  loadAllJournalEntries,
  saveJournalEntry,
} from "./journal";
import { validateOracleOutput, validateWeekendCryptoScreening, filterNonCompliantSetups, filterR036Setups, logFailure, loadRecentFailures, applySetupCountPenalty } from "./validate";
import { buildAnalyticsSummary }                                    from "./analytics";
import { fetchRSSNews, formatRSSForPrompt }                          from "./rss";
import { notifySessionComplete }                                     from "./notifications";
import { MEMORY_DIR, ANALYSIS_RULES_PATH } from "./utils";
import type { AnalysisRules, MarketSnapshot, OracleAnalysis, AxiomReflection, ForgeRequest, ForgeResult, JournalEntry } from "./types";

// ── Session ID generator ───────────────────────────────────

function generateSessionId(): string {
  return `nx-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function getSessionNumber(): number {
  const entries = loadAllJournalEntries();
  return entries.length + 1;
}

function buildPreviousSessionsContext(): string {
  const allEntries = loadAllJournalEntries();
  const recent = allEntries.slice(-3); // last 3
  if (recent.length === 0) return "";

  // Count consecutive sessions with zero rule changes (from most recent backwards)
  let noChangeStreak = 0;
  for (let i = allEntries.length - 1; i >= 0; i--) {
    const ruleUpdates = allEntries[i].reflection?.ruleUpdates ?? [];
    if (ruleUpdates.length === 0) {
      noChangeStreak++;
    } else {
      break;
    }
  }

  const sessionLines = recent.map((e) => {
    const ruleChangeCount = e.reflection?.ruleUpdates?.length ?? 0;
    return `Session #${e.sessionNumber} (${e.date}): ${e.oracleSummary}\nReflection: ${e.axiomSummary}\nRule changes this session: ${ruleChangeCount}`;
  }).join("\n\n");

  const streakLine = `\n\nEvolution status: ${noChangeStreak} consecutive session(s) with ZERO rule changes.`;

  return sessionLines + streakLine;
}

// Pure helper — exported for testing. Counts consecutive sessions from
// most-recent where AXIOM took no concrete action (no rule updates,
// no resolved self-tasks, no code changes). resolvedSelfTaskCount and
// codeChangeCount were added to AxiomReflection so closing developer-fixed
// tasks also breaks the stagnation streak.
export function computeNoChangeStreak(entries: JournalEntry[]): number {
  let streak = 0;
  for (let i = entries.length - 1; i >= 0; i--) {
    const r = entries[i].reflection;
    const ruleUpdates       = r?.ruleUpdates            ?? [];
    const resolvedTasks     = (r as any)?.resolvedSelfTaskCount ?? 0;
    const codeChanges       = (r as any)?.codeChangeCount       ?? 0;
    if (ruleUpdates.length === 0 && resolvedTasks === 0 && codeChanges === 0) {
      streak++;
    } else {
      break;
    }
  }
  return streak;
}

function getNoChangeStreak(): number {
  return computeNoChangeStreak(loadAllJournalEntries());
}

function getConsecutiveZeroSetupCount(): number {
  const allEntries = loadAllJournalEntries();
  let streak = 0;
  for (let i = allEntries.length - 1; i >= 0; i--) {
    const setups = allEntries[i].fullAnalysis?.setups ?? [];
    const conf   = allEntries[i].fullAnalysis?.confidence ?? 0;
    if (setups.length === 0 && conf > 50) {
      streak++;
    } else {
      break;
    }
  }
  return streak;
}

function buildSetupOutcomes(snapshots: MarketSnapshot[]): string {
  const allEntries = loadAllJournalEntries();
  if (allEntries.length === 0) return "";

  const lastEntry = allEntries[allEntries.length - 1];
  const setups = lastEntry.fullAnalysis?.setups;
  if (!setups || setups.length === 0) return "";

  // Build a price lookup from current snapshots
  const priceMap: Record<string, number> = {};
  for (const snap of snapshots) {
    priceMap[snap.symbol] = snap.price;
    priceMap[snap.name] = snap.price;
    // Also store lowercase name for fuzzy matching
    priceMap[snap.name.toLowerCase()] = snap.price;
  }

  const lines: string[] = [];
  for (const setup of setups) {
    // Try to find current price by instrument name or symbol
    const currentPrice = priceMap[setup.instrument]
      ?? priceMap[setup.instrument.toLowerCase()]
      ?? null;

    if (currentPrice === null || setup.entry == null) continue;

    const direction = setup.direction ?? "unknown";
    const entry  = setup.entry;
    const stop   = setup.stop;
    const target = setup.target;

    let status = "UNKNOWN";
    if (stop != null && target != null) {
      if (direction === "bullish") {
        if (currentPrice <= stop)        status = "STOPPED OUT";
        else if (currentPrice >= target) status = "TARGET HIT";
        else                             status = "OPEN";
      } else if (direction === "bearish") {
        if (currentPrice >= stop)        status = "STOPPED OUT";
        else if (currentPrice <= target) status = "TARGET HIT";
        else                             status = "OPEN";
      }
    }

    lines.push(
      `Previous session setup: ${setup.instrument} ${direction.toUpperCase()} ` +
      `entry ${entry}, stop ${stop ?? "N/A"}, target ${target ?? "N/A"}. ` +
      `Current price: ${currentPrice}. Status: ${status}`
    );
  }

  return lines.length > 0 ? lines.join("\n") : "";
}

function buildWeekdayBridge(): string {
  const allEntries = loadAllJournalEntries();
  // Find the most recent weekday session
  for (let i = allEntries.length - 1; i >= 0; i--) {
    const e = allEntries[i];
    const d = new Date(e.date.replace(" ", "T") + ":00Z");
    const day = d.getUTCDay();
    if (day !== 0 && day !== 6) {
      const setups = e.fullAnalysis?.setups ?? [];
      const setupLines = setups.length > 0
        ? setups.map(s => `  ${s.instrument} ${s.direction} (${s.type})`).join("\n")
        : "  No setups";
      return `### Where traditional markets left off (Session #${e.sessionNumber}, ${e.date}):
Bias: ${e.fullAnalysis?.bias?.overall?.toUpperCase() ?? "unknown"} — ${e.fullAnalysis?.bias?.notes ?? ""}
Confidence: ${e.fullAnalysis?.confidence ?? "?"}%
Setups:
${setupLines}
Use this context to assess whether weekend crypto behavior is following or diverging from the broader market trend.`;
    }
  }
  return "";
}

function loadRules(): AnalysisRules {
  if (fs.existsSync(ANALYSIS_RULES_PATH)) {
    return JSON.parse(fs.readFileSync(ANALYSIS_RULES_PATH, "utf-8"));
  }
  return { version: 1, lastUpdated: "", rules: [], focusInstruments: [], sessionNotes: "" };
}

// ── Repetition Detection ──────────────────────────────────

export function detectRepeatedCritiques(entries: import("./types").JournalEntry[]): { critique: string; count: number } {
  const recent = entries.slice(-5);
  if (recent.length < 3) return { critique: "", count: 0 };

  const critiques = recent.map(e => e.reflection?.whatFailed ?? "");
  // Require only the 3 most recent entries to be non-empty — one blank older session
  // shouldn't kill detection of an active streak
  const lastThree = critiques.slice(-3);
  if (lastThree.some(c => c.length === 0)) return { critique: "", count: 0 };

  // Split the MOST RECENT critique into sentences — not the oldest.
  // Using critiques[0] caused the bug: if the oldest session had a different topic,
  // it would never find overlap with the current streak.
  const sentences = critiques[critiques.length - 1].split(/[.!?]+/).map(s => s.trim()).filter(s => s.length > 10);

  const repeated: string[] = [];
  for (const sentence of sentences) {
    const words = new Set(sentence.toLowerCase().split(/\s+/));
    // Check if this sentence's words appear in all 3 critiques
    const appearsInAll = critiques.every(c => {
      const cWords = new Set(c.toLowerCase().split(/\s+/));
      let overlap = 0;
      for (const w of words) {
        if (cWords.has(w)) overlap++;
      }
      return overlap / words.size > 0.6;
    });
    if (appearsInAll) repeated.push(sentence);
  }

  if (repeated.length === 0) return { critique: "", count: 0 };

  // Count how many consecutive sessions share this critique
  const allCritiques = entries.slice(-10).map(e => e.reflection?.whatFailed ?? "");
  const words = new Set(repeated[0].toLowerCase().split(/\s+/));
  let count = 0;
  for (let i = allCritiques.length - 1; i >= 0; i--) {
    const cWords = new Set(allCritiques[i].toLowerCase().split(/\s+/));
    let overlap = 0;
    for (const w of words) { if (cWords.has(w)) overlap++; }
    if (overlap / words.size > 0.6) count++;
    else break;
  }
  return { critique: repeated[0], count };
}

// ── Weekend detection ─────────────────────────────────────

export function isWeekend(date: Date = new Date()): boolean {
  const day = date.getDay();
  return day === 0 || day === 6;
}

// ── Phase functions ───────────────────────────────────────

interface InputData {
  snapshots: MarketSnapshot[];
  macroText: string;
  rssText: string;
  issuesText: string;
  selfTasksText: string;
  selfTaskNumbers: number[];
  issueNumbers: number[];
  isWeekend: boolean;
}

export async function fetchAllInputData(): Promise<InputData> {
  const weekend = isWeekend();

  console.log(chalk.bold.yellow("  ── PHASE 1: DATA FETCH ──\n"));

  if (weekend) {
    // Weekend: crypto only from Binance, skip macro
    const phase1Spinner = ora({ text: "Fetching weekend crypto data from Binance...", color: "yellow" }).start();

    const [cryptoResult, issuesResult, selfTasksResult, rssResult] = await Promise.allSettled([
      fetchCryptoMarkets(),
      fetchCommunityIssues(),
      fetchOpenSelfTasks(),
      fetchRSSNews(),
    ]);

    // ── Handle crypto (required) ──
    let snapshots: MarketSnapshot[];
    if (cryptoResult.status === "fulfilled") {
      snapshots = cryptoResult.value;
      if (snapshots.length === 0) {
        phase1Spinner.fail("Failed to fetch crypto data: all Binance API calls returned null (0 crypto instruments)");
        throw new Error("Weekend session requires crypto market data — all Binance fetches failed (0 crypto instruments)");
      }
      phase1Spinner.succeed(chalk.green(`Weekend: Fetched ${snapshots.length} crypto instruments from Binance`));
    } else {
      phase1Spinner.fail("Failed to fetch crypto data");
      throw cryptoResult.reason;
    }

    // ── Handle issues (optional) ──
    let issuesText = "";
    let issueNumbers: number[] = [];
    if (issuesResult.status === "fulfilled") {
      const issues = issuesResult.value;
      issueNumbers = issues.map((i) => i.number);
      if (issues.length > 0) {
        issuesText = formatIssuesForPrompt(issues);
      }
    }

    // ── Handle self-tasks (optional) ──
    let selfTasksText    = "";
    let selfTaskNumbers: number[] = [];
    if (selfTasksResult.status === "fulfilled") {
      const selfTasks = selfTasksResult.value;
      setCachedOpenTasks(selfTasks);
      selfTaskNumbers = selfTasks.map((t) => t.number);
      if (selfTasks.length > 0) {
        selfTasksText = formatSelfTasksForPrompt(selfTasks);
      }
    }

    printMarketsTable(snapshots);

    // Print issues details
    if (issuesResult.status === "fulfilled") {
      const issues = issuesResult.value;
      if (issues.length > 0) {
        console.log(chalk.dim(`  Community issues: `) + chalk.cyan(`${issues.length} open`));
        for (const issue of issues) {
          const emoji = issue.label === "feedback" ? "🔴" : issue.label === "challenge" ? "🟡" : "🟢";
          console.log(chalk.dim(`    ${emoji} #${issue.number} ${issue.title}`));
        }
        console.log("");
      } else {
        console.log(chalk.dim("  Community issues: none open\n"));
      }
    } else {
      console.log(chalk.dim("  Community issues: unavailable\n"));
    }

    // Print self-tasks details
    if (selfTasksResult.status === "fulfilled") {
      const selfTasks = selfTasksResult.value;
      if (selfTasks.length > 0) {
        console.log(chalk.dim(`  Open self-tasks: `) + chalk.yellow(`${selfTasks.length} pending`));
        for (const t of selfTasks) {
          console.log(chalk.dim(`    ✦ #${t.number} [${t.category}] ${t.title}`));
        }
        console.log("");
      } else {
        console.log(chalk.dim("  Open self-tasks: none\n"));
      }
    } else {
      console.log(chalk.dim("  Open self-tasks: unavailable\n"));
    }

    // ── Handle RSS news (optional) ──
    let rssText = "";
    if (rssResult.status === "fulfilled") {
      const rssSnapshot = rssResult.value;
      if (rssSnapshot.articles.length > 0) {
        rssText = formatRSSForPrompt(rssSnapshot);
        console.log(chalk.dim(`  RSS news: `) + chalk.cyan(`${rssSnapshot.articles.length} headlines from ${rssSnapshot.articles.length > 0 ? new Set(rssSnapshot.articles.map(a => a.source)).size : 0} feeds`));
        if (rssSnapshot.errors.length > 0) {
          for (const e of rssSnapshot.errors) console.log(chalk.dim(`    ⚠ ${e}`));
        }
      } else {
        console.log(chalk.dim("  RSS news: no headlines\n"));
      }
    } else {
      console.log(chalk.dim("  RSS news: unavailable\n"));
    }

    return { snapshots, macroText: "", rssText, issuesText, selfTasksText, selfTaskNumbers, issueNumbers, isWeekend: true };
  }

  // ── Weekday: full data fetch ──
  const phase1Spinner = ora({ text: "Fetching market data, macro context, issues, RSS news...", color: "yellow" }).start();

  const [marketsResult, macroResult, issuesResult, selfTasksResult, rssResult] = await Promise.allSettled([
    fetchAllMarkets(),
    fetchMacroSnapshot(),
    fetchCommunityIssues(),
    fetchOpenSelfTasks(),
    fetchRSSNews(),
  ]);

  // ── Handle markets (required) ──
  let snapshots;
  if (marketsResult.status === "fulfilled") {
    snapshots = marketsResult.value;
  } else {
    phase1Spinner.fail("Failed to fetch market data");
    throw marketsResult.reason;
  }

  // ── Handle macro (optional) ──
  let macroText = "";
  if (macroResult.status === "fulfilled") {
    const macroSnapshot = macroResult.value;
    const sourceCount = macroSnapshot.indicators.length + (macroSnapshot.treasuryDebt.length > 0 ? 1 : 0) + (macroSnapshot.geopoliticalEvents.total > 0 ? 1 : 0);
    if (sourceCount > 0) {
      macroText = formatMacroForPrompt(macroSnapshot);
    }
  }

  // ── Handle issues (optional) ──
  let issuesText = "";
  let issueNumbers: number[] = [];
  if (issuesResult.status === "fulfilled") {
    const issues = issuesResult.value;
    issueNumbers = issues.map((i) => i.number);
    if (issues.length > 0) {
      issuesText = formatIssuesForPrompt(issues);
    }
  }

  // ── Handle self-tasks (optional) ──
  let selfTasksText    = "";
  let selfTaskNumbers: number[] = [];
  if (selfTasksResult.status === "fulfilled") {
    const selfTasks = selfTasksResult.value;
    setCachedOpenTasks(selfTasks);
    selfTaskNumbers = selfTasks.map((t) => t.number);
    if (selfTasks.length > 0) {
      selfTasksText = formatSelfTasksForPrompt(selfTasks);
    }
  }

  // ── Summarize Phase 1 results ──
  const failedSources: string[] = [];
  if (macroResult.status === "rejected") failedSources.push("macro");
  if (issuesResult.status === "rejected") failedSources.push("issues");
  if (selfTasksResult.status === "rejected") failedSources.push("self-tasks");
  if (rssResult.status === "rejected") failedSources.push("rss");

  if (failedSources.length > 0) {
    phase1Spinner.warn(chalk.yellow(`Fetched ${snapshots.length} instruments (${failedSources.join(", ")} unavailable)`));
  } else {
    phase1Spinner.succeed(chalk.green(`Fetched ${snapshots.length} instruments + macro, issues, self-tasks, RSS news`));
  }

  printMarketsTable(snapshots);

  // Print macro details
  if (macroResult.status === "fulfilled") {
    const macroSnapshot = macroResult.value;
    const sourceCount = macroSnapshot.indicators.length + (macroSnapshot.treasuryDebt.length > 0 ? 1 : 0) + (macroSnapshot.geopoliticalEvents.total > 0 ? 1 : 0);
    if (sourceCount > 0) {
      console.log(chalk.green(`  Macro context: ${macroSnapshot.indicators.length} indicators, ${macroSnapshot.signals.length} signals, ${macroSnapshot.geopoliticalEvents.total} events, ${macroSnapshot.alphaVantage.technicals.length} technicals`));
      printMacroSummary(macroSnapshot);
    } else {
      console.log(chalk.dim("  Macro data: no sources available"));
    }
    if (macroSnapshot.errors.length > 0) {
      for (const e of macroSnapshot.errors) console.log(chalk.dim(`    ⚠ ${e}`));
    }
  } else {
    console.log(chalk.dim("  Macro data: unavailable\n"));
  }

  // Print issues details
  if (issuesResult.status === "fulfilled") {
    const issues = issuesResult.value;
    if (issues.length > 0) {
      console.log(chalk.dim(`  Community issues: `) + chalk.cyan(`${issues.length} open`));
      for (const issue of issues) {
        const emoji = issue.label === "feedback" ? "🔴" : issue.label === "challenge" ? "🟡" : "🟢";
        console.log(chalk.dim(`    ${emoji} #${issue.number} ${issue.title}`));
      }
      console.log("");
    } else {
      console.log(chalk.dim("  Community issues: none open\n"));
    }
  } else {
    console.log(chalk.dim("  Community issues: unavailable\n"));
  }

  // Print self-tasks details
  if (selfTasksResult.status === "fulfilled") {
    const selfTasks = selfTasksResult.value;
    if (selfTasks.length > 0) {
      console.log(chalk.dim(`  Open self-tasks: `) + chalk.yellow(`${selfTasks.length} pending`));
      for (const t of selfTasks) {
        console.log(chalk.dim(`    ✦ #${t.number} [${t.category}] ${t.title}`));
      }
      console.log("");
    } else {
      console.log(chalk.dim("  Open self-tasks: none\n"));
    }
  } else {
    console.log(chalk.dim("  Open self-tasks: unavailable\n"));
  }

  // ── Handle RSS news (optional) ──
  let rssText = "";
  if (rssResult.status === "fulfilled") {
    const rssSnapshot = rssResult.value;
    if (rssSnapshot.articles.length > 0) {
      rssText = formatRSSForPrompt(rssSnapshot);
      const feedCount = new Set(rssSnapshot.articles.map(a => a.source)).size;
      console.log(chalk.dim(`  RSS news: `) + chalk.cyan(`${rssSnapshot.articles.length} headlines from ${feedCount} feeds`));
      if (rssSnapshot.errors.length > 0) {
        for (const e of rssSnapshot.errors) console.log(chalk.dim(`    ⚠ ${e}`));
      }
    } else {
      console.log(chalk.dim("  RSS news: no headlines\n"));
    }
  } else {
    console.log(chalk.dim("  RSS news: unavailable\n"));
  }

  return { snapshots, macroText, rssText, issuesText, selfTasksText, selfTaskNumbers, issueNumbers, isWeekend: false };
}

export async function runAndValidateOracle(
  client: Anthropic,
  snapshots: MarketSnapshot[],
  sessionId: string,
  sessionNumber: number,
  issuesText: string,
  macroText: string,
  weekendMode: boolean = false
): Promise<{ oracle: OracleAnalysis; oracleWarnings: string[] }> {
  console.log(chalk.bold.yellow("  ── PHASE 2: ORACLE ANALYSIS ──\n"));
  const oracleSpinner = ora({ text: "ORACLE analyzing (2 calls: analysis + setups)...", color: "yellow" }).start();

  let oracle;
  try {
    oracle = await runOracleAnalysis(client, snapshots, sessionId, sessionNumber, issuesText, macroText, weekendMode);
    oracleSpinner.succeed(
      chalk.green(`Analysis complete — ${oracle.bias.overall.toUpperCase()} bias, ${oracle.setups.length} setups, ${oracle.confidence}% confidence`)
    );
  } catch (err) {
    oracleSpinner.fail("ORACLE analysis failed");
    throw err;
  }

  // Validate ORACLE output
  const allEntries = loadAllJournalEntries();
  const oracleValidation = validateOracleOutput(oracle, allEntries);
  const oracleWarnings = oracleValidation.warnings;
  if (oracleWarnings.length > 0) {
    for (const w of oracleWarnings) console.warn(`  ⚠ Oracle: ${w}`);
  }
  if (!oracleValidation.valid) {
    console.error(`  ✗ ORACLE output failed validation: ${oracleValidation.errors.join('; ')}`);
    logFailure({
      sessionNumber, timestamp: new Date().toISOString(),
      phase: "oracle", errors: oracleValidation.errors,
      warnings: oracleValidation.warnings, action: "skipped"
    });
    console.log("  Session skipped — invalid ORACLE output.");
    // Throw a specific error so runSession knows to return (not crash-log)
    const err = new Error("ORACLE validation failed");
    (err as any).oracleValidationFailure = true;
    throw err;
  }

  // Filter setups that violate r029 stop distance requirements
  const { oracle: filteredOracle, removed: removedSetups } = filterNonCompliantSetups(oracle);
  if (removedSetups.length > 0) {
    for (const r of removedSetups) {
      console.warn(`  ⚠ r029: removed setup [${r.instrument}] — ${r.reason}`);
    }
    oracle = filteredOracle;
  }

  // Filter bearish risk asset setups that violate r036 (DXY weakness confirmation)
  const { oracle: r036FilteredOracle, removed: r036RemovedSetups } = filterR036Setups(oracle);
  if (r036RemovedSetups.length > 0) {
    for (const r of r036RemovedSetups) {
      console.warn(`  ⚠ r036: removed setup [${r.instrument}] — ${r.reason}`);
    }
    oracle = r036FilteredOracle;
  }

  // Re-apply setup count penalty if r029/r036 filtering reduced the setup count after
  // computeOracleConfidence() already computed confidence using the pre-filter count.
  // Example (session #222): ORACLE produced 3 setups → no penalty at 57%. filterNonCompliantSetups
  // removed the Oil setup (0.82% stop, oil moved 3.6%) → 2 setups remain, confidence never recomputed.
  // We call applySetupCountPenalty on the already-penalised confidence, which is safe because:
  //   • if count didn't change, same threshold applies → no new penalty
  //   • if count dropped below threshold, penalty fires on the already-penalised value
  //   • if already-penalised value is ≤50%, minSetups=0 → no double-penalty (backlog #23 guard)
  // Do NOT call resolveConfidence() — it would undo prior penalties (backlog #23).
  const { penalized: postFilterConf, reason: postFilterReason } = applySetupCountPenalty(
    oracle.confidence, oracle.setups.length, weekendMode
  );
  if (postFilterReason) {
    console.warn(`  ⚠ Post-filter setup count penalty: ${postFilterReason}`);
    oracle = { ...oracle, confidence: postFilterConf };
  }

  // Note: confidence is already resolved and penalized by computeOracleConfidence() inside
  // runOracleAnalysis(). Do NOT call resolveConfidence() again here — it would silently undo
  // any setup-count penalty by seeing diff > 10pts between analysis text and penalized value.
  // See backlog #23 and computeOracleConfidence() in oracle.ts.

  // Print brief summary
  console.log("");
  console.log(chalk.dim("  Analysis preview:"));
  const preview = oracle.analysis.slice(0, 300).replace(/\n/g, " ");
  console.log(chalk.white(`  "${preview}..."\n`));

  if (oracle.setups.length > 0) {
    console.log(chalk.dim("  Setups:"));
    for (const s of oracle.setups) {
      const arrow = s.direction === "bullish" ? chalk.green("↑") : s.direction === "bearish" ? chalk.red("↓") : chalk.dim("—");
      console.log(`  ${arrow} ${chalk.cyan(s.instrument.padEnd(14))} ${chalk.dim(s.type)}`);
    }
    console.log("");
  }

  return { oracle, oracleWarnings };
}

export function formatComplianceReport(warnings: string[]): string {
  if (warnings.length === 0) return "";
  const lines = warnings.map(w => `- ${w}`).join("\n");
  return `\n\n## ORACLE Compliance Report
The following validation warnings were triggered this session:
${lines}
These are persistent issues. If a warning has appeared 3+ sessions in a row, write a rule to address it.`;
}

export async function runAndValidateAxiom(
  client: Anthropic,
  oracle: OracleAnalysis,
  sessionNumber: number,
  snapshots: MarketSnapshot[],
  issuesText: string,
  selfTasksText: string,
  selfTaskNumbers: number[],
  issueNumbers: number[] = [],
  weekendMode: boolean = false,
  oracleWarnings: string[] = []
): Promise<{ reflection: AxiomReflection; forgeRequests: ForgeRequest[] }> {
  console.log(chalk.bold.yellow("  ── PHASE 3: AXIOM REFLECTION ──\n"));
  const axiomSpinner = ora({ text: "AXIOM reflecting on cognitive performance...", color: "magenta" }).start();

  let reflection;
  let axiomResult: Awaited<ReturnType<typeof runAxiomReflection>>;
  let prevContext = buildPreviousSessionsContext();

  // Inject recent failures into AXIOM context
  const recentFailures = loadRecentFailures();
  if (recentFailures.length > 0) {
    const last5 = recentFailures.slice(-5);
    const failureLines = last5.map((f) =>
      `- Session #${f.sessionNumber} (${f.timestamp}): ${f.phase} ${f.action} — ${f.errors.join('; ')}`
    ).join("\n");
    prevContext += `\n\n### Recent session failures:\n${failureLines}\nConsider these when proposing code changes.`;
  }

  // Inject analytics summary so AXIOM knows its own performance patterns
  const allEntries = loadAllJournalEntries();
  const analyticsSummary = buildAnalyticsSummary(allEntries);
  if (analyticsSummary) {
    prevContext += "\n\n" + analyticsSummary;
  }

  // Inject screening compliance so AXIOM knows if screening was adequate
  let screeningNote: string;
  if (weekendMode) {
    // Weekend: check coverage of every available crypto instrument by name
    const { covered, mentionedOnly, missing } = validateWeekendCryptoScreening(oracle, snapshots);
    const fullyComplete = missing.length === 0 && mentionedOnly.length === 0;
    if (fullyComplete) {
      screeningNote = `\n\n### Weekend screening compliance: ✅ COMPLETE
- All ${covered.length} crypto instruments have valid setups or key levels: ${covered.join(", ")}`;
    } else {
      const parts: string[] = [`\n\n### Weekend screening compliance: ❌ INCOMPLETE`];
      parts.push(`- With valid setup/key level (${covered.length}): ${covered.join(", ") || "none"}`);
      if (mentionedOnly.length > 0) {
        parts.push(`- Text mention only — NO setup or key level produced (${mentionedOnly.length}): ${mentionedOnly.join(", ")}`);
        parts.push(`  ↳ Mentioning an instrument in narrative WITHOUT a setup or key level is NOT r030 compliance.`);
      }
      if (missing.length > 0) {
        parts.push(`- Completely ignored (${missing.length}): ${missing.join(", ")}`);
      }
      parts.push(`- r030 requires ALL ${snapshots.length} instruments to have a setup or key level.`);
      parts.push(`- This is a RULE VIOLATION. You MUST open a self-task or propose a code fix — do NOT just note it again.`);
      screeningNote = parts.join("\n");
    }
  } else {
    const setupCategories = new Set(oracle.setups.map((s: any) => {
      const name = (s.instrument ?? "").toLowerCase();
      if (name.includes("eur") || name.includes("gbp") || name.includes("usd") || name.includes("jpy") || name.includes("aud") || name.includes("cad") || name.includes("nzd") || name.includes("chf")) return "forex";
      if (name.includes("nas") || name.includes("s&p") || name.includes("spx") || name.includes("dow") || name.includes("dax") || name.includes("ftse")) return "indices";
      if (name.includes("bitcoin") || name.includes("btc") || name.includes("ethereum") || name.includes("eth") || name.includes("solana") || name.includes("xrp") || name.includes("bnb") || name.includes("cardano") || name.includes("doge") || name.includes("avax") || name.includes("polkadot") || name.includes("chainlink")) return "crypto";
      if (name.includes("gold") || name.includes("silver") || name.includes("plat") || name.includes("copper")) return "metals";
      if (name.includes("oil") || name.includes("crude") || name.includes("gas")) return "energy";
      return "other";
    }));
    screeningNote = `\n\n### Screening compliance this session:
- Setups produced: ${oracle.setups.length}
- Asset classes covered: ${[...setupCategories].join(", ")} (${setupCategories.size} of 5)
- Screening is ADEQUATE if setups span 3+ asset classes. You do NOT need to produce setups for all 17 instruments — only instruments with valid structural levels aligned with your bias deserve a setup.
- If you covered 3+ asset classes, do NOT critique screening as a failure. Focus your reflection on analysis quality instead.`;
  }
  prevContext += screeningNote;

  // Inject ORACLE compliance warnings so AXIOM can write rules to fix recurring issues
  const complianceReport = formatComplianceReport(oracleWarnings);
  if (complianceReport) {
    prevContext += complianceReport;
  }

  // Detect repeated critiques across recent sessions
  const { critique: repeatedCritique, count: repeatCount } = detectRepeatedCritiques(allEntries);
  if (repeatedCritique && repeatCount >= 3) {
    prevContext += `\n\n### REPETITION ALERT (${repeatCount} consecutive sessions)
You have repeated this same critique for ${repeatCount} sessions without taking action:
"${repeatedCritique}"
This session you MUST either:
1. Open a self-task issue to track this gap (not a rule — a self-task)
2. Propose a code change via codeChanges to fix it
3. Explicitly state why this gap is unfixable and commit to STOP repeating it
System prompt additions about this same topic do NOT count as action.`;
  }

  try {
    const noChangeStreak             = getNoChangeStreak();
    const consecutiveZeroSetupCount  = getConsecutiveZeroSetupCount();
    const setupOutcomes              = buildSetupOutcomes(snapshots);
    const closeableNumbers = [...selfTaskNumbers, ...issueNumbers];
    axiomResult = await runAxiomReflection(client, oracle, sessionNumber, prevContext, issuesText, selfTasksText, closeableNumbers, noChangeStreak, setupOutcomes, weekendMode, consecutiveZeroSetupCount);
    reflection = axiomResult.reflection;

    // Block system prompt additions when AXIOM is ruminating without real action,
    // and auto-create a self-task so there is persistent pressure across sessions.
    if (repeatedCritique && repeatCount >= 3) {
      // Always strip system prompt addition — adding more text about enforcement never helps
      if (reflection.newSystemPromptSections) {
        console.warn(`  ⚠ AXIOM rumination block: system prompt addition stripped (${repeatCount} sessions of same critique without concrete action)`);
        reflection.newSystemPromptSections = "";
      }
      // Auto-create a self-task if no code-level fix was proposed.
      // Dedup in createSelfTask prevents duplicate issues if AXIOM already opened one.
      if (axiomResult.forgeRequests.length === 0) {
        try {
          const taskTitle = `Recurring execution gap (${repeatCount} sessions): ${repeatedCritique.slice(0, 70)}`;
          await createSelfTask({
            title:         taskTitle,
            body:          `NEXUS identified this same gap for **${repeatCount} consecutive sessions** without taking concrete action:\n\n> "${repeatedCritique}"\n\nThis self-task was auto-created by the agent because AXIOM kept adding system prompt text without building enforcement. Resolve by:\n1. Building a code-level validation gate in validate.ts or agent.ts\n2. Writing a rule that can be mechanically checked\n3. Explicitly accepting this as a known limitation and closing this issue`,
            category:      "blind-spot",
            priority:      "high",
            sessionOpened: sessionNumber,
          }, sessionNumber);
          console.warn(`  ⚠ AXIOM rumination: auto-created self-task after ${repeatCount} sessions of same critique`);
        } catch (err) {
          console.warn(`  ⚠ Failed to auto-create rumination self-task: ${err}`);
        }
      }
    }

    // Independent enforcement: weekend screening violation with no corrective action.
    // This fires regardless of repeatCount so it cannot be evaded by varying critique language.
    if (weekendMode && screeningNote.includes("❌ INCOMPLETE")) {
      const hasCorrectiveAction = axiomResult.forgeRequests.length > 0;
      if (!hasCorrectiveAction) {
        console.warn(`  ⚠ r030 enforcement: screening violation with no forge request — stripping system prompt addition`);
        reflection.newSystemPromptSections = "";
      }
    }

    axiomSpinner.succeed(
      chalk.green(`Reflection complete — ${reflection.ruleUpdates.length} rule updates, mind evolved`)
    );
  } catch (err) {
    axiomSpinner.fail("AXIOM reflection failed");
    throw err;
  }

  console.log("");
  console.log(chalk.dim("  Evolution:"));
  const evoPreview = reflection.evolutionSummary.slice(0, 250).replace(/\n/g, " ");
  console.log(chalk.white(`  "${evoPreview}..."\n`));

  if (reflection.cognitiveBiases.length > 0) {
    console.log(chalk.dim("  Biases detected: ") + chalk.magenta(reflection.cognitiveBiases.join(", ")));
    console.log("");
  }

  return { reflection, forgeRequests: axiomResult.forgeRequests };
}

export async function runAndValidateForge(
  client: Anthropic,
  forgeRequests: ForgeRequest[],
  sessionNumber: number
): Promise<ForgeResult[]> {
  if (forgeRequests.length === 0) return [];

  console.log(chalk.bold.yellow("  ── PHASE 3b: FORGE CODE EVOLUTION ──\n"));
  const forgeSpinner = ora({ text: "FORGE applying code changes...", color: "cyan" }).start();

  let forgeResults: ForgeResult[] = [];
  try {
    forgeResults = await runForge(client, forgeRequests, sessionNumber);
    const succeeded = forgeResults.filter(r => r.success).length;
    const failed    = forgeResults.filter(r => !r.success).length;
    forgeSpinner.succeed(chalk.green(`FORGE complete — ${succeeded} patched, ${failed} failed/reverted`));

    // Auto-close linked self-tasks for successful FORGE patches
    for (let i = 0; i < forgeResults.length; i++) {
      const result  = forgeResults[i];
      const request = forgeRequests[i];
      if (result.success && request.selfTaskIssueNumber) {
        const { closeSelfTask } = await import("./self-tasks");
        const closed = await closeSelfTask(
          request.selfTaskIssueNumber,
          `FORGE patched \`${result.file}\` in session #${sessionNumber}. ${result.reason}`,
          sessionNumber
        );
        if (closed) console.log(chalk.green(`    ✓ Auto-closed self-task #${request.selfTaskIssueNumber}`));
      }
    }
  } catch (err) {
    forgeSpinner.fail("FORGE failed");
    console.warn(chalk.yellow(`  ⚠ FORGE error (non-fatal): ${err}`));
  }
  // Check FORGE diff size — reject patches over 200 lines as likely hallucinated
  for (let i = 0; i < forgeResults.length; i++) {
    const result = forgeResults[i];
    if (result.success && result.linesChanged && result.linesChanged > 200) {
      console.warn(`  ⚠ FORGE patch too large: ${result.file} changed ${result.linesChanged} lines (max 200)`);
      try {
        execSync(`git checkout -- src/${path.basename(result.file)}`, { cwd: process.cwd(), stdio: "pipe" });
        forgeResults[i] = { ...result, success: false, reason: `Reverted — patch too large (${result.linesChanged} lines, max 200)`, reverted: true };
      } catch (err) {
        console.debug(chalk.dim(`  [debug] FORGE large-patch revert failed: ${err}`));
      }
    }
  }

  // After FORGE completes, verify no protected files were touched
  if (forgeResults.some(r => r.success)) {
    try {
      const diffOutput = execSync("git diff --name-only src/security.ts src/forge.ts .github/workflows/session.yml README.md", {
        cwd: process.cwd(), stdio: "pipe", encoding: "utf-8"
      }).trim();
      if (diffOutput) {
        console.error(`  🛡️ PROTECTED FILE VIOLATION: ${diffOutput}`);
        console.error(`  Reverting ALL FORGE changes...`);
        execSync("git checkout -- src/ README.md", { cwd: process.cwd(), stdio: "pipe" });
        forgeResults = forgeResults.map(r => ({
          ...r, success: false, reason: "Reverted — protected file violation detected", reverted: true
        }));
      }
    } catch (err) {
      console.debug(chalk.dim(`  [debug] FORGE protected-file check failed: ${err}`));
    }
  }

  console.log("");
  return forgeResults;
}

export async function writeSessionOutput(
  sessionNumber: number,
  oracle: OracleAnalysis,
  reflection: AxiomReflection,
  snapshots: MarketSnapshot[],
  weekendMode: boolean = false
): Promise<void> {
  console.log(chalk.bold.yellow("  ── PHASE 4: JOURNAL ──\n"));
  const journalSpinner = ora({ text: "Writing journal entry...", color: "cyan" }).start();

  const rules   = loadRules();
  const entry   = buildJournalEntry(sessionNumber, oracle, reflection, rules, weekendMode);
  const mdPath  = writeJournalMarkdown(entry);
  saveJournalEntry(entry);

  const updatedEntries = loadAllJournalEntries();
  updateGithubPages(updatedEntries);
  updateReadmeSessionsTable(updatedEntries);

  journalSpinner.succeed(chalk.green("Journal written, GitHub Pages updated, README updated"));
  console.log(chalk.dim(`  Markdown: ${mdPath}`));
  console.log(chalk.dim(`  Site:     ${path.join(process.cwd(), "docs", "index.html")}\n`));

  // Send Telegram notification (optional, skips silently if not configured)
  await notifySessionComplete(entry);
}

// ── Main run ───────────────────────────────────────────────

export async function runSession(force = false): Promise<void> {
  // Header
  const weekend = isWeekend();
  console.log(chalk.bold.white("\n╔══════════════════════════════════════════╗"));
  if (weekend) {
    console.log(chalk.bold.white("║  ") + chalk.bold.yellow("NEXUS") + chalk.dim("  —  WEEKEND SESSION — Crypto Only") + chalk.bold.white("      ║"));
  } else {
    console.log(chalk.bold.white("║  ") + chalk.bold.yellow("NEXUS") + chalk.dim("  —  The Market Mind That Rewrites Itself") + chalk.bold.white("  ║"));
  }
  console.log(chalk.bold.white("╚══════════════════════════════════════════╝\n"));

  const startTime     = new Date();
  const sessionId     = generateSessionId();
  const sessionNumber = getSessionNumber();

  console.log(chalk.dim(`  Session:   `) + chalk.cyan(`#${sessionNumber}`));
  console.log(chalk.dim(`  ID:        `) + chalk.dim(sessionId));
  console.log(chalk.dim(`  Started:   `) + chalk.dim(format(startTime, "yyyy-MM-dd HH:mm:ss")));
  console.log("");

  // Init
  initMemoryIfNeeded();

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    console.error(chalk.red("  ✗ ANTHROPIC_API_KEY not set. Add it to .env"));
    process.exit(1);
  }

  const client = new Anthropic({ apiKey, maxRetries: 6 });

  // Capture git HEAD for session-level rollback on failure
  let sessionStartSha = "";
  try {
    sessionStartSha = execSync("git rev-parse HEAD", { cwd: process.cwd(), stdio: "pipe", encoding: "utf-8" }).trim();
  } catch (err) {
    console.debug(chalk.dim(`  [debug] git SHA capture failed: ${err}`));
  }

 let currentPhase: "oracle" | "axiom" | "forge" | "journal" = "oracle";
 try {
  // Pre-flight: verify codebase compiles before starting session
  console.log(chalk.dim("  Pre-flight: checking TypeScript build..."));
  try {
    execSync("npx tsc --noEmit", { cwd: process.cwd(), stdio: "pipe", timeout: 30000 });
    console.log(chalk.dim("  Pre-flight: build OK\n"));
  } catch (err) {
    console.error(chalk.red("  ✗ Pre-flight build check FAILED — codebase is broken"));
    logFailure({
      sessionNumber, timestamp: new Date().toISOString(),
      phase: "oracle", errors: ["Pre-flight tsc --noEmit failed — codebase broken before session started"],
      warnings: [], action: "skipped"
    });
    return;
  }

  currentPhase = "oracle";
  const { snapshots, macroText, rssText, issuesText, selfTasksText, selfTaskNumbers, issueNumbers, isWeekend: weekendMode } = await fetchAllInputData();

  // On weekends, inject last weekday session context so ORACLE knows where traditional markets left off
  // RSS news is always appended regardless of weekend/weekday
  let oracleContext = weekendMode ? buildWeekdayBridge() : macroText;
  if (rssText) {
    oracleContext += (oracleContext ? "\n\n" : "") + rssText;
  }

  currentPhase = "oracle";
  const { oracle, oracleWarnings } = await runAndValidateOracle(client, snapshots, sessionId, sessionNumber, issuesText, oracleContext, weekendMode);

  currentPhase = "axiom";
  const { reflection, forgeRequests } = await runAndValidateAxiom(client, oracle, sessionNumber, snapshots, issuesText, selfTasksText, selfTaskNumbers, issueNumbers, weekendMode, oracleWarnings);

  currentPhase = "forge";
  await runAndValidateForge(client, forgeRequests, sessionNumber);

  currentPhase = "journal";
  await writeSessionOutput(sessionNumber, oracle, reflection, snapshots, weekendMode);

  // ── Summary ──
  const rules = loadRules();
  const elapsed = ((Date.now() - startTime.getTime()) / 1000).toFixed(1);
  console.log(chalk.bold.white("╔══════════════════════════════════════╗"));
  console.log(chalk.bold.white("║  ") + chalk.bold.green("SESSION COMPLETE") + chalk.bold.white("                       ║"));
  console.log(chalk.bold.white("╠══════════════════════════════════════╣"));
  console.log(chalk.bold.white("║  ") + chalk.dim("Session:   ") + chalk.cyan(`#${sessionNumber}`.padEnd(25)) + chalk.bold.white("║"));
  console.log(chalk.bold.white("║  ") + chalk.dim("Elapsed:   ") + chalk.white(`${elapsed}s`.padEnd(25)) + chalk.bold.white("║"));
  console.log(chalk.bold.white("║  ") + chalk.dim("Bias:      ") + chalk.yellow(oracle.bias.overall.padEnd(25)) + chalk.bold.white("║"));
  console.log(chalk.bold.white("║  ") + chalk.dim("Setups:    ") + chalk.white(String(oracle.setups.length).padEnd(25)) + chalk.bold.white("║"));
  console.log(chalk.bold.white("║  ") + chalk.dim("Rules now: ") + chalk.white(String(rules.rules.length).padEnd(25)) + chalk.bold.white("║"));
  console.log(chalk.bold.white("╚══════════════════════════════════════╝\n"));

 } catch (err) {
    // ORACLE validation failure is already logged — just return cleanly
    if ((err as any)?.oracleValidationFailure) return;

    console.error(`  ✗ Session failed with unhandled error: ${err}`);
    logFailure({
      sessionNumber, timestamp: new Date().toISOString(),
      phase: currentPhase, errors: [String(err)], warnings: [], action: "skipped"
    });
    // Rollback any uncommitted changes from this session
    if (sessionStartSha) {
      try {
        execSync("git checkout -- .", { cwd: process.cwd(), stdio: "pipe" });
        console.log("  ↩ Rolled back uncommitted changes from failed session");
      } catch (err) {
        console.debug(chalk.dim(`  [debug] session rollback failed: ${err}`));
      }
    }
    // Don't re-throw — let the process exit cleanly so GitHub Actions doesn't fail
  }
}
