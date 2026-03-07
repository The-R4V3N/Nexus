#!/usr/bin/env node
// ============================================================
// NEXUS — CLI Entry Point
// ============================================================

import "dotenv/config";
import { Command } from "commander";
import chalk from "chalk";
import { runSession } from "./agent";
import { loadAllJournalEntries, updateGithubPages } from "./journal";
import * as fs from "fs";
import * as path from "path";

const MEMORY_DIR = path.join(process.cwd(), "memory");
const ANALYSIS_RULES_PATH = path.join(MEMORY_DIR, "analysis-rules.json");
const SYSTEM_PROMPT_PATH = path.join(MEMORY_DIR, "system-prompt.md");

const program = new Command();

program
  .name("nexus")
  .description("NEXUS — The self-evolving market intelligence agent")
  .version("0.0.1");

// ── run: execute a full session ────────────────────────────
program
  .command("run")
  .description("Run a full ORACLE + AXIOM session")
  .option("--force", "Run even on weekends")
  .action(async (opts: { force?: boolean }) => {
    try {
      await runSession(opts.force ?? false);
    } catch (err) {
      console.error(chalk.red("\n  ✗ Session failed:"), err);
      process.exit(1);
    }
  });

// ── status: show current state ─────────────────────────────
program
  .command("status")
  .description("Show NEXUS current memory state")
  .action(() => {
    const entries = loadAllJournalEntries();
    const rules = fs.existsSync(ANALYSIS_RULES_PATH)
      ? JSON.parse(fs.readFileSync(ANALYSIS_RULES_PATH, "utf-8"))
      : null;

    console.log(chalk.bold.yellow("\n  NEXUS STATUS\n"));
    console.log(chalk.dim("  Sessions run: ") + chalk.white(entries.length));
    console.log(chalk.dim("  Rules:        ") + chalk.white(rules?.rules?.length ?? 0));
    console.log(chalk.dim("  Prompt ver:   ") + chalk.white(rules?.version ?? 1));

    if (entries.length > 0) {
      const last = entries[entries.length - 1];
      console.log(chalk.dim("  Last session: ") + chalk.cyan(`#${last.sessionNumber}`));
      console.log(chalk.dim("  Last bias:    ") + chalk.yellow(last.fullAnalysis.bias.overall));
      console.log(chalk.dim("  Last run:     ") + chalk.dim(last.date));
    }

    const promptExists = fs.existsSync(SYSTEM_PROMPT_PATH);
    console.log(chalk.dim("  Memory files: ") + (promptExists ? chalk.green("initialized") : chalk.red("not yet initialized")));
    console.log("");
  });

// ── journal: list journal entries ─────────────────────────
program
  .command("journal")
  .description("List all journal entries")
  .option("-n, --last <n>", "Show last N entries", "5")
  .action((opts: { last: string }) => {
    const entries = loadAllJournalEntries();
    const n = parseInt(opts.last, 10);
    const shown = entries.slice(-n).reverse();

    console.log(chalk.bold.yellow(`\n  NEXUS JOURNAL (last ${n})\n`));

    if (shown.length === 0) {
      console.log(chalk.dim("  No sessions yet. Run: npm run run:session"));
    } else {
      for (const e of shown) {
        const biasColor = e.fullAnalysis.bias.overall === "bullish" ? chalk.green
          : e.fullAnalysis.bias.overall === "bearish" ? chalk.red : chalk.dim;

        console.log(
          chalk.cyan(`  #${String(e.sessionNumber).padStart(3, "0")}`) +
          chalk.dim(` ${e.date}  `) +
          biasColor(e.fullAnalysis.bias.overall.padEnd(8)) +
          chalk.white(` conf:${e.fullAnalysis.confidence}%`)
        );
        console.log(chalk.dim(`       ${e.title}`));
        console.log("");
      }
    }
  });

// ── mind: show current rules ───────────────────────────────
program
  .command("mind")
  .description("Show NEXUS current analysis rules")
  .action(() => {
    if (!fs.existsSync(ANALYSIS_RULES_PATH)) {
      console.log(chalk.dim("  No rules yet. Run a session first."));
      return;
    }

    const rules = JSON.parse(fs.readFileSync(ANALYSIS_RULES_PATH, "utf-8"));
    console.log(chalk.bold.yellow(`\n  NEXUS MIND — ${rules.rules.length} rules (v${rules.version})\n`));
    console.log(chalk.dim(`  Focus: ${rules.focusInstruments.join(", ")}\n`));

    const byCategory: Record<string, typeof rules.rules> = {};
    for (const r of rules.rules) {
      if (!byCategory[r.category]) byCategory[r.category] = [];
      byCategory[r.category].push(r);
    }

    for (const [cat, items] of Object.entries(byCategory) as [string, typeof rules.rules][]) {
      console.log(chalk.dim(`  ── ${cat.toUpperCase()} ──`));
      for (const r of items.sort((a: { weight: number }, b: { weight: number }) => b.weight - a.weight)) {
        console.log(chalk.dim(`  [${r.id}]`) + chalk.cyan(` [W:${r.weight}] `) + chalk.white(r.description));
      }
      console.log("");
    }
  });

// ── rebuild: regenerate docs from saved sessions ───────────
program
  .command("rebuild-site")
  .description("Regenerate GitHub Pages from saved session data")
  .action(() => {
    const entries = loadAllJournalEntries();
    updateGithubPages(entries);
    console.log(chalk.green(`  ✓ Rebuilt site with ${entries.length} sessions`));
  });

program.parse(process.argv);

// Show help if no command given
if (!process.argv.slice(2).length) {
  console.log(chalk.bold.yellow("\n  NEXUS — The Market Mind That Rewrites Itself\n"));
  console.log(chalk.dim("  Commands:"));
  console.log(chalk.white("    npm run run:session") + chalk.dim("   — Run a full analysis session"));
  console.log(chalk.white("    npx ts-node src/index.ts status") + chalk.dim("  — Current state"));
  console.log(chalk.white("    npx ts-node src/index.ts journal") + chalk.dim(" — List sessions"));
  console.log(chalk.white("    npx ts-node src/index.ts mind") + chalk.dim("    — Show current rules"));
  console.log("");
}