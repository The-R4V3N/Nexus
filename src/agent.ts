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

function buildSetupOutcomes(snapshots: import("./types").MarketSnapshot[]): string {
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

  // Capture git HEAD for session-level rollback on failure
  let sessionStartSha = "";
  try {
    sessionStartSha = execSync("git rev-parse HEAD", { cwd: process.cwd(), stdio: "pipe", encoding: "utf-8" }).trim();
  } catch { /* not a git repo or git not available */ }

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

  // ── Phase 1d: Macro & geopolitical context ──
  let macroText = "";
  try {
    const macroSpinner = ora({ text: "Fetching macro & geopolitical data...", color: "yellow" }).start();
    const macroSnapshot = await fetchMacroSnapshot();
    const sourceCount = macroSnapshot.indicators.length + (macroSnapshot.treasuryDebt.length > 0 ? 1 : 0) + (macroSnapshot.geopoliticalEvents.total > 0 ? 1 : 0);
    if (sourceCount > 0) {
      macroSpinner.succeed(chalk.green(`Macro context: ${macroSnapshot.indicators.length} indicators, ${macroSnapshot.signals.length} signals, ${macroSnapshot.geopoliticalEvents.total} events, ${macroSnapshot.alphaVantage.technicals.length} technicals`));
      printMacroSummary(macroSnapshot);
      macroText = formatMacroForPrompt(macroSnapshot);
    } else {
      macroSpinner.info(chalk.dim("Macro data: no sources available"));
    }
    if (macroSnapshot.errors.length > 0) {
      for (const e of macroSnapshot.errors) console.log(chalk.dim(`    ⚠ ${e}`));
    }
  } catch {
    console.log(chalk.dim("  Macro data: unavailable\n"));
  }

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
    setCachedOpenTasks(selfTasks);
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
    oracle = await runOracleAnalysis(client, snapshots, sessionId, sessionNumber, issuesText, macroText);
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
    return;
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

  try {
    const noChangeStreak = getNoChangeStreak();
    const setupOutcomes  = buildSetupOutcomes(snapshots);
    axiomResult = await runAxiomReflection(client, oracle, sessionNumber, prevContext, issuesText, selfTasksText, selfTaskNumbers, noChangeStreak, setupOutcomes);
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

  // ── Phase 3b: FORGE — code evolution (only runs when AXIOM requests changes) ──
  let forgeResults: import("./types").ForgeResult[] = [];
  if (axiomResult.forgeRequests.length > 0) {
    console.log(chalk.bold.yellow("  ── PHASE 3b: FORGE CODE EVOLUTION ──\n"));
    const forgeSpinner = ora({ text: "FORGE applying code changes...", color: "cyan" }).start();
    try {
      forgeResults = await runForge(client, axiomResult.forgeRequests, sessionNumber);
      const succeeded = forgeResults.filter(r => r.success).length;
      const failed    = forgeResults.filter(r => !r.success).length;
      forgeSpinner.succeed(chalk.green(`FORGE complete — ${succeeded} patched, ${failed} failed/reverted`));

      // Auto-close linked self-tasks for successful FORGE patches
      for (let i = 0; i < forgeResults.length; i++) {
        const result  = forgeResults[i];
        const request = axiomResult.forgeRequests[i];
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
        } catch { /* best effort */ }
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
      } catch { /* git diff returns non-zero if files don't exist, that's fine */ }
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

  const updatedEntries = loadAllJournalEntries();
  updateGithubPages(updatedEntries);
  updateReadmeSessionsTable(updatedEntries);

  journalSpinner.succeed(chalk.green("Journal written, GitHub Pages updated, README updated"));
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

 } catch (err) {
    console.error(`  ✗ Session failed with unhandled error: ${err}`);
    logFailure({
      sessionNumber, timestamp: new Date().toISOString(),
      phase: "oracle", errors: [String(err)], warnings: [], action: "skipped"
    });
    // Rollback any uncommitted changes from this session
    if (sessionStartSha) {
      try {
        execSync("git checkout -- .", { cwd: process.cwd(), stdio: "pipe" });
        console.log("  ↩ Rolled back uncommitted changes from failed session");
      } catch { /* best effort */ }
    }
    // Don't re-throw — let the process exit cleanly so GitHub Actions doesn't fail
  }
}