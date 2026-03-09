// ============================================================
// NEXUS — Agent Orchestrator
// Runs the full ORACLE → AXIOM → JOURNAL cycle
// ============================================================

import Anthropic  from "@anthropic-ai/sdk";
import chalk      from "chalk";
import ora        from "ora";
import * as fs    from "fs";
import * as path  from "path";
import { format } from "date-fns";
import { fetchAllMarkets, printMarketsTable }                     from "./markets";
import { fetchCommunityIssues, formatIssuesForPrompt }             from "./issues";
import { fetchOpenSelfTasks, formatSelfTasksForPrompt }           from "./self-tasks";
import { runOracleAnalysis }                                       from "./oracle";
import { runAxiomReflection, initMemoryIfNeeded }                  from "./axiom";
import { runForge, formatForgeResults }                             from "./forge";
import {
  buildJournalEntry,
  writeJournalMarkdown,
  updateGithubPages,
  loadAllJournalEntries,
  saveJournalEntry,
} from "./journal";
import type { AnalysisRules } from "./types";

const MEMORY_DIR           = path.join(process.cwd(), "memory");
const ANALYSIS_RULES_PATH  = path.join(MEMORY_DIR, "analysis-rules.json");

// ── Session ID generator ───────────────────────────────────

function generateSessionId(): string {
  return `nx-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function getSessionNumber(): number {
  const entries = loadAllJournalEntries();
  return entries.length + 1;
}

function buildPreviousSessionsContext(): string {
  const entries = loadAllJournalEntries().slice(-3); // last 3
  if (entries.length === 0) return "";

  return entries
    .map(
      (e) =>
        `Session #${e.sessionNumber} (${e.date}): ${e.oracleSummary}\nReflection: ${e.axiomSummary}`
    )
    .join("\n\n");
}

function loadRules(): AnalysisRules {
  if (fs.existsSync(ANALYSIS_RULES_PATH)) {
    return JSON.parse(fs.readFileSync(ANALYSIS_RULES_PATH, "utf-8"));
  }
  return { version: 1, lastUpdated: "", rules: [], focusInstruments: [], sessionNotes: "" };
}

// ── Weekday guard ─────────────────────────────────────────

function isTradingDay(force = false): boolean {
  if (force) return true;
  const day = new Date().getDay(); // 0 = Sunday, 6 = Saturday
  return day >= 1 && day <= 5;
}

// ── Main run ───────────────────────────────────────────────

export async function runSession(force = false): Promise<void> {
  // Header
  console.log(chalk.bold.white("\n╔══════════════════════════════════════════╗"));
  console.log(chalk.bold.white("║  ") + chalk.bold.yellow("NEXUS") + chalk.dim("  —  The Market Mind That Rewrites Itself") + chalk.bold.white("  ║"));
  console.log(chalk.bold.white("╚══════════════════════════════════════════╝\n"));

  // Weekend guard
  if (!isTradingDay(force)) {
    const days = ["Sunday","Monday","Tuesday","Wednesday","Thursday","Friday","Saturday"];
    console.log(chalk.yellow(`  ⚠  Today is ${days[new Date().getDay()]} — markets are closed.`));
    console.log(chalk.dim("  NEXUS only runs Monday–Friday."));
    console.log(chalk.dim("  To run anyway: npm run run:session -- --force\n"));
    return;
  }

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

  // ── Phase 1: Fetch market data ──
  console.log(chalk.bold.yellow("  ── PHASE 1: MARKET DATA ──\n"));
  const marketSpinner = ora({ text: "Fetching live market data...", color: "yellow" }).start();

  let snapshots;
  try {
    snapshots = await fetchAllMarkets();
    marketSpinner.succeed(chalk.green(`Fetched ${snapshots.length} instruments`));
  } catch (err) {
    marketSpinner.fail("Failed to fetch market data");
    throw err;
  }

  printMarketsTable(snapshots);

  // ── Phase 1b: Community issues ──
  let issuesText = "";
  try {
    const issues = await fetchCommunityIssues();
    if (issues.length > 0) {
      console.log(chalk.dim(`  Community issues: `) + chalk.cyan(`${issues.length} open`));
      issuesText = formatIssuesForPrompt(issues);
      for (const issue of issues) {
        const emoji = issue.label === "feedback" ? "🔴" : issue.label === "challenge" ? "🟡" : "🟢";
        console.log(chalk.dim(`    ${emoji} #${issue.number} ${issue.title}`));
      }
      console.log("");
    } else {
      console.log(chalk.dim("  Community issues: none open\n"));
    }
  } catch {
    console.log(chalk.dim("  Community issues: unavailable\n"));
  }

  // ── Phase 1c: Open self-tasks ──
  let selfTasksText    = "";
  let selfTaskNumbers: number[] = [];
  try {
    const selfTasks = await fetchOpenSelfTasks();
    selfTaskNumbers = selfTasks.map((t) => t.number);
    if (selfTasks.length > 0) {
      console.log(chalk.dim(`  Open self-tasks: `) + chalk.yellow(`${selfTasks.length} pending`));
      for (const t of selfTasks) {
        console.log(chalk.dim(`    ✦ #${t.number} [${t.category}] ${t.title}`));
      }
      selfTasksText = formatSelfTasksForPrompt(selfTasks);
      console.log("");
    } else {
      console.log(chalk.dim("  Open self-tasks: none\n"));
    }
  } catch {
    console.log(chalk.dim("  Open self-tasks: unavailable\n"));
  }

  // ── Phase 2: ORACLE analysis ──
  console.log(chalk.bold.yellow("  ── PHASE 2: ORACLE ANALYSIS ──\n"));
  const oracleSpinner = ora({ text: "ORACLE analyzing market structure...", color: "yellow" }).start();

  let oracle;
  try {
    oracle = await runOracleAnalysis(client, snapshots, sessionId, sessionNumber, issuesText);
    oracleSpinner.succeed(
      chalk.green(`Analysis complete — ${oracle.bias.overall.toUpperCase()} bias, ${oracle.setups.length} setups, ${oracle.confidence}% confidence`)
    );
  } catch (err) {
    oracleSpinner.fail("ORACLE analysis failed");
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

  // ── Phase 3: AXIOM reflection ──
  console.log(chalk.bold.yellow("  ── PHASE 3: AXIOM REFLECTION ──\n"));
  const axiomSpinner = ora({ text: "AXIOM reflecting on cognitive performance...", color: "magenta" }).start();

  let reflection;
  let axiomResult: Awaited<ReturnType<typeof runAxiomReflection>>;
  const prevContext = buildPreviousSessionsContext();

  try {
    axiomResult = await runAxiomReflection(client, oracle, sessionNumber, prevContext, issuesText, selfTasksText, selfTaskNumbers);
    reflection = axiomResult.reflection;
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

  // ── Phase 3b: FORGE — code evolution ──
  let forgeResults: import("./types").ForgeResult[] = [];
  if (axiomResult.forgeRequests.length > 0) {
    console.log(chalk.bold.yellow("  ── PHASE 3b: FORGE CODE EVOLUTION ──\n"));
    const forgeSpinner = ora({ text: "FORGE applying code changes...", color: "cyan" }).start();
    try {
      forgeResults = await runForge(client, axiomResult.forgeRequests, sessionNumber);
      const succeeded = forgeResults.filter(r => r.success).length;
      const failed    = forgeResults.filter(r => !r.success).length;
      forgeSpinner.succeed(chalk.green(`FORGE complete — ${succeeded} patched, ${failed} failed/reverted`));
    } catch (err) {
      forgeSpinner.fail("FORGE failed");
      console.warn(chalk.yellow(`  ⚠ FORGE error (non-fatal): ${err}`));
    }
    console.log("");
  }

  // ── Phase 4: Journal ──
  console.log(chalk.bold.yellow("  ── PHASE 4: JOURNAL ──\n"));
  const journalSpinner = ora({ text: "Writing journal entry...", color: "cyan" }).start();

  const rules   = loadRules();
  const entry   = buildJournalEntry(sessionNumber, oracle, reflection, rules);
  const mdPath  = writeJournalMarkdown(entry);
  saveJournalEntry(entry);

  const allEntries = loadAllJournalEntries();
  updateGithubPages(allEntries);

  journalSpinner.succeed(chalk.green("Journal written, GitHub Pages updated"));
  console.log(chalk.dim(`  Markdown: ${mdPath}`));
  console.log(chalk.dim(`  Site:     ${path.join(process.cwd(), "docs", "index.html")}\n`));

  // ── Summary ──
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
}