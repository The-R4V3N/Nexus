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
import { fetchOpenSelfTasks, formatSelfTasksForPrompt, setCachedOpenTasks } from "./self-tasks";
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
import { validateOracleOutput, logFailure, loadRecentFailures }    from "./validate";
import { buildAnalyticsSummary }                                    from "./analytics";
import { fetchRSSNews, formatRSSForPrompt }                          from "./rss";
import { MEMORY_DIR, ANALYSIS_RULES_PATH } from "./utils";
import type { AnalysisRules, MarketSnapshot, OracleAnalysis, AxiomReflection, ForgeRequest, ForgeResult } from "./types";

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

function getNoChangeStreak(): number {
  const allEntries = loadAllJournalEntries();
  let streak = 0;
  for (let i = allEntries.length - 1; i >= 0; i--) {
    const ruleUpdates = allEntries[i].reflection?.ruleUpdates ?? [];
    if (ruleUpdates.length === 0) {
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
  if (critiques.some(c => c.length === 0)) return { critique: "", count: 0 };

  // Split first critique into sentences
  const sentences = critiques[0].split(/[.!?]+/).map(s => s.trim()).filter(s => s.length > 10);

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
): Promise<OracleAnalysis> {
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
  if (oracleValidation.warnings.length > 0) {
    for (const w of oracleValidation.warnings) console.warn(`  ⚠ Oracle: ${w}`);
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

  return oracle;
}

export async function runAndValidateAxiom(
  client: Anthropic,
  oracle: OracleAnalysis,
  sessionNumber: number,
  snapshots: MarketSnapshot[],
  issuesText: string,
  selfTasksText: string,
  selfTaskNumbers: number[],
  issueNumbers: number[] = []
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
    const noChangeStreak = getNoChangeStreak();
    const setupOutcomes  = buildSetupOutcomes(snapshots);
    const closeableNumbers = [...selfTaskNumbers, ...issueNumbers];
    axiomResult = await runAxiomReflection(client, oracle, sessionNumber, prevContext, issuesText, selfTasksText, closeableNumbers, noChangeStreak, setupOutcomes);
    reflection = axiomResult.reflection;

    // Block system prompt additions when AXIOM is ruminating without real action
    if (repeatedCritique && repeatCount >= 3) {
      const hasRealAction = reflection.ruleUpdates.length > 0 || axiomResult.forgeRequests.length > 0;
      if (!hasRealAction && reflection.newSystemPromptSections) {
        console.warn(`  ⚠ AXIOM rumination block: system prompt addition stripped (${repeatCount} sessions of same critique without rule/code action)`);
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

export function writeSessionOutput(
  sessionNumber: number,
  oracle: OracleAnalysis,
  reflection: AxiomReflection,
  snapshots: MarketSnapshot[],
  weekendMode: boolean = false
): void {
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

  const client = new Anthropic({ apiKey });

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
  const oracle = await runAndValidateOracle(client, snapshots, sessionId, sessionNumber, issuesText, oracleContext, weekendMode);

  currentPhase = "axiom";
  const { reflection, forgeRequests } = await runAndValidateAxiom(client, oracle, sessionNumber, snapshots, issuesText, selfTasksText, selfTaskNumbers, issueNumbers);

  currentPhase = "forge";
  await runAndValidateForge(client, forgeRequests, sessionNumber);

  currentPhase = "journal";
  writeSessionOutput(sessionNumber, oracle, reflection, snapshots, weekendMode);

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
