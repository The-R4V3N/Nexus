// ============================================================
// NEXUS — Journal Module
// Writes markdown entries + updates GitHub Pages site
// ============================================================

import * as fs from "fs";
import * as path from "path";
import { format } from "date-fns";
import type { JournalEntry, OracleAnalysis, AxiomReflection, AnalysisRules } from "./types";

const JOURNAL_DIR = path.join(process.cwd(), "journal");
const DOCS_DIR = path.join(process.cwd(), "docs");

// ── Build Journal Entry ────────────────────────────────────

export function buildJournalEntry(
  sessionNumber: number,
  oracle: OracleAnalysis,
  reflection: AxiomReflection,
  rules: AnalysisRules
): JournalEntry {
  const setupSummary = oracle.setups.length > 0
    ? oracle.setups.map((s) => `${s.instrument} ${s.type} (${s.direction})`).join(", ")
    : "No high-probability setups identified";

  const title = generateSessionTitle(oracle, reflection);

  return {
    sessionNumber,
    date: format(new Date(), "yyyy-MM-dd HH:mm"),
    title,
    oracleSummary: `${oracle.bias.overall.toUpperCase()} bias | ${oracle.setups.length} setups | Confidence: ${oracle.confidence}/100 | ${setupSummary}`,
    axiomSummary: reflection.evolutionSummary,
    fullAnalysis: oracle,
    reflection,
    ruleCount: rules.rules.length,
    systemPromptVersion: rules.version,
  };
}

function generateSessionTitle(oracle: OracleAnalysis, reflection: AxiomReflection): string {
  const biasEmoji = { bullish: "↑", bearish: "↓", neutral: "—", mixed: "↕" };
  const emoji = biasEmoji[oracle.bias.overall] ?? "—";
  const topSetup = oracle.setups[0];
  if (topSetup) {
    return `${emoji} ${topSetup.instrument} ${topSetup.type} + ${reflection.ruleUpdates.length > 0 ? "rule evolution" : "no rule changes"}`;
  }
  return `${emoji} No clear setups — ${(reflection.whatFailed ?? "").split(".")[0]}`;
}

// ── Write Markdown Journal ─────────────────────────────────

export function writeJournalMarkdown(entry: JournalEntry): string {
  fs.mkdirSync(JOURNAL_DIR, { recursive: true });

  const filename = `session-${String(entry.sessionNumber).padStart(4, "0")}-${(entry.date ?? "unknown").replace(/[: ]/g, "-")}.md`;
  const filepath = path.join(JOURNAL_DIR, filename);

  const biasIcon = { bullish: "🟢", bearish: "🔴", neutral: "⚪", mixed: "🟡" };

  const content = `# Session #${entry.sessionNumber} — ${entry.title}

**Date:** ${entry.date}
**Bias:** ${biasIcon[entry.fullAnalysis.bias.overall] ?? "⚪"} ${entry.fullAnalysis.bias.overall.toUpperCase()}
**Confidence:** ${entry.fullAnalysis.confidence}/100
**Rules:** ${entry.ruleCount} (v${entry.systemPromptVersion})

---

## 🔭 ORACLE — Market Analysis

${entry.fullAnalysis.analysis}

### Bias

${entry.fullAnalysis.bias.overall.toUpperCase()} — ${entry.fullAnalysis.bias.notes}

### Setups Identified (${entry.fullAnalysis.setups.length})

${entry.fullAnalysis.setups.length === 0 ? "No high-probability setups this session." :
      entry.fullAnalysis.setups.map((s: any) => {
        const specs = s.entry ? `  \nEntry: **${s.entry}** | Stoploss: **${s.stop}** | Target: **${s.target}** | Risk/Reward: **${s.RR}** | Timeframe: **${s.timeframe}**` : "";
        return `**${s.instrument}** — ${s.type} (${s.direction.toUpperCase()})

${s.description}${specs}

Invalidation: ${s.invalidation}`;
      }).join("\n\n---\n\n")}

### Key Levels

${entry.fullAnalysis.keyLevels.length === 0 ? "No key levels identified." :
      entry.fullAnalysis.keyLevels.map((l) =>
        `- **${l.instrument}** ${l.level} (${l.type}): ${l.notes}`
      ).join("\n")}

---

## 🧠 AXIOM — Cognitive Reflection

${entry.reflection.evolutionSummary}

### What Worked

${entry.reflection.whatWorked}

### What Failed

${entry.reflection.whatFailed}

${entry.reflection.cognitiveBiases.length > 0 ? `### Cognitive Biases Detected

${entry.reflection.cognitiveBiases.map((b) => `- ${b}`).join("\n")}` : ""}

${entry.reflection.ruleUpdates.length > 0 ? `### Rule Updates (${entry.reflection.ruleUpdates.length})

${entry.reflection.ruleUpdates.map((u) => `**[${u.type.toUpperCase()}]** \`${u.ruleId}\`
Reason: ${u.reason}
${u.before ? `Before: ${u.before}  \n` : ""}${u.after ? `After: ${u.after}` : ""}`).join("\n\n")}` : "No rule changes this session."}

${entry.reflection.newSystemPromptSections ? `### System Prompt Evolution

> ${entry.reflection.newSystemPromptSections}` : ""}
`;

  fs.writeFileSync(filepath, content);
  return filepath;
}

// ── Update GitHub Pages ────────────────────────────────────

export function updateGithubPages(entries: JournalEntry[]): void {
  fs.mkdirSync(DOCS_DIR, { recursive: true });

  const sorted = [...entries].sort((a, b) => b.sessionNumber - a.sessionNumber);
  const latest = sorted[0];
  const totalRules = latest?.ruleCount ?? 0;

  const journalHTML = sorted.map((e, i) => buildEntryHTML(e, i)).join("\n");

  const html = buildPageHTML(journalHTML, sorted.length, totalRules, latest);
  fs.writeFileSync(path.join(DOCS_DIR, "index.html"), html);
}

// ── Load all journal entries (cached per session) ─────────

let _entriesCache: JournalEntry[] | null = null;

export function loadAllJournalEntries(): JournalEntry[] {
  if (_entriesCache !== null) return _entriesCache;
  const stored = path.join(process.cwd(), "memory", "sessions.json");
  if (!fs.existsSync(stored)) return [];
  _entriesCache = JSON.parse(fs.readFileSync(stored, "utf-8"));
  return _entriesCache!;
}

export function invalidateEntriesCache(): void {
  _entriesCache = null;
}

const MAX_SESSIONS = 500;

export function saveJournalEntry(entry: JournalEntry): void {
  const stored = path.join(process.cwd(), "memory", "sessions.json");
  const entries = loadAllJournalEntries();
  entries.push(entry);
  if (entries.length > MAX_SESSIONS) {
    entries.splice(0, entries.length - MAX_SESSIONS);
  }
  fs.writeFileSync(stored, JSON.stringify(entries, null, 2));
  invalidateEntriesCache();
}

// ── README sessions table auto-update ─────────────────────

export function updateReadmeSessionsTable(entries: JournalEntry[]): void {
  const readmePath = path.join(process.cwd(), "README.md");
  if (!fs.existsSync(readmePath)) return;

  let readme = fs.readFileSync(readmePath, "utf-8");

  const tableHeader = "| # | Date | Bias | Setups | Confidence | Rule Δ |";
  const tableSep    = "| - | ---- | ---- | ------ | ---------- | ------ |";
  const tableEnd    = "*This table will be updated automatically each session.*";

  const startIdx = readme.indexOf(tableHeader);
  const endIdx   = readme.indexOf(tableEnd);
  if (startIdx === -1 || endIdx === -1) return;

  // Build table rows from last 10 sessions (newest first)
  const recent = [...entries].sort((a, b) => b.sessionNumber - a.sessionNumber).slice(0, 10);
  const rows = recent.map((e) => {
    const bias   = e.fullAnalysis.bias.overall;
    const setups = e.fullAnalysis.setups.length;
    const conf   = e.fullAnalysis.confidence;
    const rules  = e.ruleCount;
    const date   = e.date.split(" ")[0];
    return `| ${e.sessionNumber} | ${date} | ${bias} | ${setups} | ${conf}% | ${rules} rules |`;
  });

  const newTable = [tableHeader, tableSep, ...rows, ""].join("\n");
  const before = readme.slice(0, startIdx);
  const after  = readme.slice(endIdx);

  readme = before + newTable + "\n" + after;
  fs.writeFileSync(readmePath, readme);
}

// ── HTML helpers ──────────────────────────────────────────

function escapeHTML(str: string): string {
  return (str ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

function escapeAndBreak(str: string): string {
  return escapeHTML(str).replace(/\n/g, "<br>");
}

// ── HTML builders ──────────────────────────────────────────

const VALID_BIASES = new Set(["bullish", "bearish", "neutral", "mixed"]);

function buildEntryHTML(entry: JournalEntry, index: number): string {
  const biasClass = VALID_BIASES.has(entry.fullAnalysis.bias.overall)
    ? escapeHTML(entry.fullAnalysis.bias.overall)
    : "neutral";
  const isFirst = index === 0; // newest entry starts expanded

  const setupsHTML = entry.fullAnalysis.setups.map((s: any) => {
    const hasSpecs = s.entry && s.entry !== 0;
    const specsLine = hasSpecs
      ? `<div class="setup-specs"><span>E: ${s.entry}</span><span>S: ${s.stop}</span><span>T: ${s.target}</span><span>RR: ${s.RR}</span><span>TF: ${escapeHTML(s.timeframe ?? "")}</span></div>`
      : "";
    return `
    <div class="setup-card ${escapeHTML(s.direction)}">
      <div class="setup-card-header">
        <span class="setup-dir">${s.direction === "bullish" ? "&#x2191;" : s.direction === "bearish" ? "&#x2193;" : "&#x2014;"}</span>
        <span class="setup-name">${escapeHTML(s.instrument)}</span>
        <span class="setup-type">${escapeHTML(s.type)}</span>
      </div>
      ${specsLine}
    </div>`;
  }).join("");

  const rulesHTML = entry.reflection.ruleUpdates.length > 0
    ? entry.reflection.ruleUpdates.map((u) => `
    <div class="rule-update ${escapeHTML(u.type)}">
      <span class="rule-type">[${escapeHTML(u.type)}]</span>
      <span class="rule-id">${escapeHTML(u.ruleId)}</span>
      <span class="rule-reason">${escapeHTML(u.reason)}</span>
    </div>`).join("")
    : `<div class="no-change">No rule changes</div>`;

  // Extract time from date string (format: "yyyy-MM-dd HH:mm")
  const dateParts = entry.date.split(" ");
  const dateStr = escapeHTML(dateParts[0] ?? entry.date);
  const timeStr = dateParts[1] ? escapeHTML(dateParts[1]) : "";

  return `
  <article class="entry${isFirst ? " expanded" : ""}" data-bias="${biasClass}">
    <div class="entry-header" onclick="this.parentElement.classList.toggle('expanded')">
      <div class="session-meta">
        <span class="session-num">SESSION_${String(entry.sessionNumber).padStart(3, "0")}</span>
        <span class="session-date">${dateStr}</span>
        ${timeStr ? `<span class="session-time">${timeStr} UTC</span>` : ""}
        <span class="confidence-badge">CONF:${entry.fullAnalysis.confidence}%</span>
        <span class="expand-icon"></span>
      </div>
      <h2 class="entry-title">${escapeHTML(entry.title)}</h2>
      <div class="bias-line">
        <span class="bias-indicator bias-${biasClass}">${escapeHTML(entry.fullAnalysis.bias.overall.toUpperCase())}</span>
        <span class="bias-note">${escapeHTML(entry.fullAnalysis.bias.notes)}</span>
      </div>
    </div>

    <div class="entry-body">
      <div class="entry-grid">
        <div class="oracle-col">
          <h3 class="col-header">// ORACLE</h3>
          <div class="analysis-text">${escapeAndBreak(entry.fullAnalysis.analysis)}</div>
          ${setupsHTML ? `<div class="setup-legend">FVG=Fair Value Gap &middot; OB=Order Block &middot; MSS=Market Structure Shift &middot; CISD=Change In State of Delivery &middot; PDH/PDL=Previous Day High/Low</div>` : ""}
          <div class="setups-row">${setupsHTML || '<span class="no-setup">NO SETUPS</span>'}</div>
        </div>

        <div class="axiom-col">
          <h3 class="col-header">// AXIOM</h3>
          <div class="evolution-text">${escapeHTML(entry.reflection.evolutionSummary)}</div>
          ${entry.reflection.cognitiveBiases.length > 0 ? `
          <div class="biases">
            ${entry.reflection.cognitiveBiases.map((b) => `<span class="bias-tag">${escapeHTML(b)}</span>`).join("")}
          </div>` : ""}
          <div class="rule-updates">
            <span class="rules-label">MIND DELTA</span>
            ${rulesHTML}
          </div>
          <div class="rule-count">rules: ${entry.ruleCount} | prompt_v${entry.systemPromptVersion}</div>
        </div>
      </div>
    </div>
  </article>`;
}

function buildPageHTML(
  journalHTML: string,
  totalSessions: number,
  totalRules: number,
  latest?: JournalEntry
): string {
  const latestBias = latest?.fullAnalysis.bias.overall ?? "neutral";
  const latestConf = latest?.fullAnalysis.confidence ?? 0;
  const latestDate = latest?.date ?? "—";

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>NEXUS — The Market Mind That Rewrites Itself</title>
<link rel="icon" type="image/svg+xml" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'%3E%3Crect width='32' height='32' rx='6' fill='%23070a0e'/%3E%3Crect width='32' height='32' rx='6' fill='none' stroke='%23f5a623' stroke-width='1.5'/%3E%3Ctext x='16' y='23' font-family='monospace' font-size='18' font-weight='bold' fill='%23f5a623' text-anchor='middle'%3EN%3C/text%3E%3C/svg%3E">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=JetBrains+Mono:ital,wght@0,400;0,700;1,400&family=Syne:wght@400;700;800&display=swap" rel="stylesheet">
<style>
  :root {
    --bg:        #070a0e;
    --bg2:       #0d1117;
    --bg3:       #141b23;
    --amber:     #f5a623;
    --amber-dim: #a06a0f;
    --green:     #39d353;
    --red:       #f85149;
    --cyan:      #58a6ff;
    --purple:    #bc8cff;
    --text:      #c9d1d9;
    --text-dim:  #484f58;
    --border:    #21262d;
    --grid:      rgba(245,166,35,0.04);
  }

  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }

  html {
    overflow-x: hidden;
    width: 100%;
  }

  body {
    background: var(--bg);
    color: var(--text);
    font-family: 'JetBrains Mono', monospace;
    font-size: 12px;
    line-height: 1.6;
    min-height: 100vh;
    overflow-x: hidden;
    overflow-wrap: break-word;
    word-break: break-word;
    width: 100%;
    max-width: 100vw;
    -webkit-text-size-adjust: 100%;
  }

  /* Grid background */
  body::before {
    content: '';
    position: fixed;
    inset: 0;
    background-image:
      linear-gradient(var(--grid) 1px, transparent 1px),
      linear-gradient(90deg, var(--grid) 1px, transparent 1px);
    background-size: 40px 40px;
    pointer-events: none;
    z-index: 0;
  }

  /* Scanline overlay */
  body::after {
    content: '';
    position: fixed;
    inset: 0;
    background: repeating-linear-gradient(
      0deg,
      transparent,
      transparent 2px,
      rgba(0,0,0,0.03) 2px,
      rgba(0,0,0,0.03) 4px
    );
    pointer-events: none;
    z-index: 0;
  }

  .container { max-width: 1200px; margin: 0 auto; padding: 0 10px; position: relative; z-index: 1; overflow-x: hidden; width: 100%; }

  /* ── Header (mobile-first) ── */
  header {
    border-bottom: 1px solid var(--border);
    padding: 20px 0 16px;
    position: relative;
  }

  .header-inner {
    display: flex;
    flex-direction: column;
    align-items: flex-start;
    gap: 16px;
  }

  .logo-block {}

  .logo-eyebrow {
    font-family: 'JetBrains Mono', monospace;
    font-size: 9px;
    color: var(--amber-dim);
    letter-spacing: 0.2em;
    text-transform: uppercase;
    margin-bottom: 4px;
  }

  h1 {
    font-family: 'Syne', sans-serif;
    font-size: clamp(32px, 8vw, 72px);
    font-weight: 800;
    color: #fff;
    letter-spacing: -0.02em;
    line-height: 1;
  }

  h1 span { color: var(--amber); }

  .tagline {
    margin-top: 8px;
    font-size: 10px;
    color: var(--text-dim);
    letter-spacing: 0.05em;
  }

  /* Status panel (mobile-first: 3 cols compact) */
  .status-grid {
    display: grid;
    grid-template-columns: repeat(3, 1fr);
    gap: 1px;
    background: var(--border);
    border: 1px solid var(--border);
    width: 100%;
  }

  .stat-cell {
    background: var(--bg2);
    padding: 8px 4px;
    text-align: center;
  }

  .stat-label {
    font-size: 8px;
    letter-spacing: 0.1em;
    color: var(--text-dim);
    text-transform: uppercase;
    display: block;
    margin-bottom: 2px;
  }

  .stat-val {
    font-family: 'Syne', sans-serif;
    font-size: 14px;
    font-weight: 700;
    color: var(--amber);
  }

  @media (min-width: 769px) {
    .container { padding: 0 24px; }
    header { padding: 40px 0 32px; }
    .header-inner { flex-direction: row; justify-content: space-between; align-items: flex-end; gap: 24px; }
    .logo-eyebrow { font-size: 10px; letter-spacing: 0.3em; }
    .tagline { font-size: 12px; }
    .status-grid { min-width: 280px; width: auto; }
    .stat-cell { padding: 12px 16px; }
    .stat-label { font-size: 9px; letter-spacing: 0.2em; margin-bottom: 4px; }
    .stat-val { font-size: 20px; }
    body { font-size: 13px; line-height: 1.7; }
  }

  .bias-bullish { color: var(--green) !important; }
  .bias-bearish { color: var(--red) !important; }
  .bias-neutral { color: var(--text-dim) !important; }
  .bias-mixed   { color: var(--cyan) !important; }

  /* Identity strip (mobile-first) */
  .identity-strip {
    border-bottom: 1px solid var(--border);
    padding: 12px 0;
    color: var(--text-dim);
    font-size: 10px;
    line-height: 1.7;
  }

  .identity-strip strong { color: var(--cyan); }

  /* Disclaimer (mobile-first) */
  .disclaimer {
    border: 1px solid rgba(248,81,73,0.3);
    background: rgba(248,81,73,0.05);
    padding: 10px 12px;
    margin: 14px 0;
    font-size: 10px;
    color: var(--text);
    line-height: 1.6;
    overflow-wrap: break-word;
    word-break: break-word;
  }

  .disclaimer-icon { color: var(--red); margin-right: 6px; }
  .disclaimer strong { color: var(--red); }

  @media (min-width: 769px) {
    .identity-strip { padding: 20px 0; font-size: 11px; line-height: 1.9; }
    .disclaimer { padding: 14px 20px; margin: 20px 0; font-size: 11px; line-height: 1.7; }
  }

  /* ── Journal ── */
  .journal-section { padding: 24px 0; }

  .section-title {
    font-size: 9px;
    letter-spacing: 0.2em;
    color: var(--amber-dim);
    text-transform: uppercase;
    margin-bottom: 16px;
    padding-bottom: 8px;
    border-bottom: 1px solid var(--border);
  }

  @media (min-width: 769px) {
    .journal-section { padding: 40px 0; }
    .section-title { font-size: 10px; letter-spacing: 0.3em; margin-bottom: 24px; }
  }

  /* Entry */
  .entry {
    border: 1px solid var(--border);
    background: var(--bg2);
    margin-bottom: 2px;
    transition: border-color 0.2s;
    position: relative;
  }

  .entry::before {
    content: '';
    position: absolute;
    top: 0; left: 0;
    width: 2px; height: 100%;
  }

  .entry[data-bias="bullish"]::before { background: var(--green); }
  .entry[data-bias="bearish"]::before { background: var(--red); }
  .entry[data-bias="neutral"]::before { background: var(--text-dim); }
  .entry[data-bias="mixed"]::before   { background: var(--cyan); }

  .entry:hover { border-color: var(--amber-dim); }

  /* Accordion (mobile-first) */
  .entry-header {
    padding: 12px 10px 10px 14px;
    border-bottom: 1px solid var(--border);
    background: var(--bg3);
    cursor: pointer;
    user-select: none;
  }

  @media (min-width: 769px) {
    .entry-header { padding: 20px 24px 16px 28px; }
  }

  .entry-body {
    max-height: 0;
    overflow: hidden;
    transition: max-height 0.35s ease;
  }

  .entry.expanded .entry-body {
    max-height: 5000px;
  }

  .expand-icon {
    margin-left: auto;
    font-size: 12px;
    color: var(--text-dim);
    transition: transform 0.25s ease;
    flex-shrink: 0;
  }

  .expand-icon::after {
    content: '\\25BC';
  }

  .entry.expanded .expand-icon {
    transform: rotate(180deg);
  }

  .session-meta {
    display: flex;
    gap: 6px;
    align-items: center;
    margin-bottom: 6px;
    flex-wrap: wrap;
  }

  .session-num {
    font-size: 9px;
    letter-spacing: 0.1em;
    color: var(--amber);
    font-weight: 700;
  }

  .session-date { font-size: 9px; color: var(--text-dim); }
  .session-time { font-size: 9px; color: var(--text-dim); font-style: italic; }

  .confidence-badge {
    font-size: 8px;
    letter-spacing: 0.1em;
    background: var(--bg);
    border: 1px solid var(--border);
    padding: 1px 6px;
    color: var(--text-dim);
  }

  .entry-title {
    font-family: 'Syne', sans-serif;
    font-size: 14px;
    font-weight: 700;
    color: #fff;
    margin-bottom: 6px;
    overflow-wrap: break-word;
    word-break: break-word;
  }

  .bias-line { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }

  .bias-indicator {
    font-size: 8px;
    letter-spacing: 0.15em;
    font-weight: 700;
    padding: 1px 6px;
    border: 1px solid;
    flex-shrink: 0;
  }

  @media (min-width: 769px) {
    .session-meta { gap: 16px; margin-bottom: 8px; }
    .session-num { font-size: 10px; letter-spacing: 0.15em; }
    .session-date, .session-time { font-size: 10px; }
    .confidence-badge { font-size: 9px; padding: 2px 8px; }
    .entry-title { font-size: 18px; margin-bottom: 8px; }
    .bias-line { gap: 10px; }
    .bias-indicator { font-size: 9px; letter-spacing: 0.2em; padding: 2px 8px; }
  }

  .bias-indicator.bias-bullish { border-color: var(--green); color: var(--green); }
  .bias-indicator.bias-bearish { border-color: var(--red);   color: var(--red); }
  .bias-indicator.bias-neutral { border-color: var(--text-dim); color: var(--text-dim); }
  .bias-indicator.bias-mixed   { border-color: var(--cyan);  color: var(--cyan); }

  .bias-note { font-size: 10px; color: var(--text-dim); overflow-wrap: break-word; word-break: break-word; }

  .entry-grid {
    display: grid;
    grid-template-columns: 1fr;
    gap: 0;
  }

  .oracle-col,
  .axiom-col {
    padding: 12px 10px 12px 14px;
  }

  .oracle-col { border-bottom: 1px solid var(--border); }

  .col-header {
    font-family: 'JetBrains Mono', monospace;
    font-size: 9px;
    letter-spacing: 0.15em;
    color: var(--amber-dim);
    margin-bottom: 10px;
    text-transform: uppercase;
  }

  .analysis-text, .evolution-text {
    font-size: 11px;
    color: var(--text);
    line-height: 1.6;
    margin-bottom: 12px;
    overflow-wrap: break-word;
    word-break: break-word;
  }

  @media (min-width: 769px) {
    .bias-note { font-size: 11px; }
    .entry-grid { grid-template-columns: 1fr 1fr; }
    .oracle-col { border-bottom: none; border-right: 1px solid var(--border); }
    .oracle-col, .axiom-col { padding: 20px 24px 20px 28px; }
    .col-header { font-size: 10px; letter-spacing: 0.2em; margin-bottom: 12px; }
    .analysis-text, .evolution-text { font-size: 12px; line-height: 1.8; margin-bottom: 14px; }
  }

  .setups-row {
    display: grid;
    grid-template-columns: 1fr;
    gap: 6px;
    margin-top: 10px;
  }

  .setup-card {
    border: 1px solid var(--border);
    background: var(--bg);
    padding: 8px 10px;
    position: relative;
    overflow: hidden;
  }

  .setup-card::before {
    content: '';
    position: absolute;
    top: 0; left: 0;
    width: 3px; height: 100%;
  }

  .setup-card.bullish::before { background: var(--green); }
  .setup-card.bearish::before { background: var(--red); }

  .setup-card-header {
    display: flex;
    align-items: center;
    gap: 6px;
    margin-bottom: 4px;
    padding-left: 6px;
  }

  .setup-name { color: var(--cyan); font-weight: 700; font-size: 11px; }
  .setup-dir  { font-weight: 700; font-size: 11px; }
  .setup-type { color: var(--text-dim); font-size: 9px; letter-spacing: 0.05em; }

  .setup-card.bullish .setup-dir { color: var(--green); }
  .setup-card.bearish .setup-dir { color: var(--red); }

  .setup-specs {
    display: grid;
    grid-template-columns: repeat(2, 1fr);
    gap: 2px 8px;
    font-size: 9px;
    color: var(--amber-dim);
    padding: 4px 6px;
    margin-top: 4px;
    border-top: 1px solid var(--border);
    letter-spacing: 0.02em;
  }

  .setup-specs span { display: block; }

  .setup-legend {
    font-size: 8px;
    color: var(--text-dim);
    letter-spacing: 0.03em;
    margin-top: 10px;
    margin-bottom: 4px;
    padding: 4px 6px;
    border: 1px solid var(--border);
    background: var(--bg);
    line-height: 1.6;
  }

  .no-setup { font-size: 9px; color: var(--text-dim); letter-spacing: 0.1em; }

  @media (min-width: 769px) {
    .setups-row { grid-template-columns: 1fr 1fr; gap: 8px; margin-top: 12px; }
    .setup-card { padding: 10px 12px; }
    .setup-name { font-size: 12px; }
    .setup-type { font-size: 10px; }
    .setup-specs { font-size: 10px; }
    .no-setup { font-size: 10px; }
  }

  .biases {
    display: flex;
    flex-wrap: wrap;
    gap: 4px;
    margin-bottom: 12px;
  }

  .bias-tag {
    font-size: 8px;
    padding: 2px 6px;
    background: rgba(188,140,255,0.1);
    border: 1px solid rgba(188,140,255,0.3);
    color: var(--purple);
    letter-spacing: 0.05em;
  }

  .rule-updates { margin-top: 10px; }

  .rules-label {
    font-size: 8px;
    letter-spacing: 0.15em;
    color: var(--amber-dim);
    display: block;
    margin-bottom: 4px;
  }

  .rule-update {
    font-size: 9px;
    padding: 4px 0;
    border-bottom: 1px solid var(--border);
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
    align-items: flex-start;
  }

  .rule-type {
    font-weight: 700;
    flex-shrink: 0;
    color: var(--amber);
  }

  .rule-type.add    { color: var(--green); }
  .rule-type.modify { color: var(--cyan); }
  .rule-type.remove { color: var(--red); }

  .rule-id     { color: var(--purple); flex-shrink: 0; }
  .rule-reason { color: var(--text-dim); overflow-wrap: break-word; word-break: break-word; }

  .no-change { font-size: 9px; color: var(--text-dim); font-style: italic; }

  .rule-count {
    margin-top: 8px;
    font-size: 8px;
    color: var(--text-dim);
    letter-spacing: 0.1em;
    text-align: right;
  }

  /* Nav bar */
  .site-nav {
    display: flex;
    justify-content: space-between;
    align-items: center;
    padding: 12px 0;
    border-bottom: 1px solid var(--border);
    flex-wrap: wrap;
    gap: 8px;
  }

  .nav-logo {
    font-family: 'Syne', sans-serif;
    font-weight: 800;
    font-size: 16px;
    color: #fff;
    text-decoration: none;
    letter-spacing: -0.02em;
  }

  .nav-logo span { color: var(--amber); }

  .nav-icon {
    width: 22px;
    height: 22px;
    vertical-align: middle;
    margin-right: 6px;
    position: relative;
    top: -1px;
  }

  .nav-links {
    display: flex;
    gap: 6px;
    align-items: center;
    flex-wrap: wrap;
  }

  .nav-links a {
    font-size: 9px;
    letter-spacing: 0.1em;
    text-transform: uppercase;
    color: var(--text-dim);
    text-decoration: none;
    padding: 4px 8px;
    border: 1px solid transparent;
    transition: color 0.2s, border-color 0.2s;
  }

  .nav-links a:hover {
    color: var(--amber);
    border-color: var(--amber-dim);
  }

  .nav-links a.nav-sponsor {
    color: var(--amber);
    border-color: var(--amber-dim);
  }

  .nav-links a.nav-sponsor:hover {
    background: rgba(245,166,35,0.1);
  }

  .nav-links .nav-sep {
    color: var(--border);
    font-size: 10px;
    user-select: none;
  }

  @media (min-width: 769px) {
    .site-nav { padding: 16px 0; }
    .nav-logo { font-size: 18px; }
    .nav-links { gap: 4px; }
    .nav-links a { font-size: 10px; padding: 5px 12px; }
  }

  /* Footer */
  footer {
    border-top: 1px solid var(--border);
    padding: 14px 0;
    text-align: center;
    font-size: 9px;
    color: var(--text-dim);
    letter-spacing: 0.1em;
  }

  footer a { color: var(--amber-dim); text-decoration: none; }

  @media (min-width: 769px) {
    .bias-tag { font-size: 9px; padding: 2px 8px; }
    .rule-updates { margin-top: 12px; }
    .rules-label { font-size: 9px; letter-spacing: 0.2em; margin-bottom: 6px; }
    .rule-update { font-size: 10px; gap: 8px; flex-wrap: nowrap; }
    .no-change { font-size: 10px; }
    .rule-count { font-size: 9px; margin-top: 10px; }
    footer { padding: 24px 0; font-size: 10px; }
  }

  /* Glow effect on load */
  @keyframes fadeIn {
    from { opacity: 0; transform: translateY(8px); }
    to   { opacity: 1; transform: translateY(0); }
  }

  .entry { animation: fadeIn 0.3s ease both; }
  .entry:nth-child(1) { animation-delay: 0.05s; }
  .entry:nth-child(2) { animation-delay: 0.10s; }
  .entry:nth-child(3) { animation-delay: 0.15s; }
  .entry:nth-child(4) { animation-delay: 0.20s; }
  .entry:nth-child(5) { animation-delay: 0.25s; }
</style>
</head>
<body>
<div class="container">
  <nav class="site-nav">
    <a href="#" class="nav-logo"><svg class="nav-icon" viewBox="0 0 32 32" xmlns="http://www.w3.org/2000/svg"><rect width="32" height="32" rx="6" fill="#070a0e"/><rect width="32" height="32" rx="6" fill="none" stroke="#f5a623" stroke-width="1.5"/><text x="16" y="23" font-family="monospace" font-size="18" font-weight="bold" fill="#f5a623" text-anchor="middle">N</text></svg>NEX<span>US</span></a>
    <div class="nav-links">
      <a href="#journal">journal</a>
      <a href="#identity">identity</a>
      <span class="nav-sep">&middot;</span>
      <a href="https://github.com/The-R4V3N/Nexus" target="_blank" rel="noopener">github &#x2197;</a>
      <a href="https://github.com/sponsors/The-R4V3N" target="_blank" rel="noopener" class="nav-sponsor">sponsor &#x2764;</a>
    </div>
  </nav>
  <header>
    <div class="header-inner">
      <div class="logo-block">
        <div class="logo-eyebrow">self-evolving market intelligence</div>
        <h1>NEX<span>US</span></h1>
        <p class="tagline">the market mind that rewrites itself</p>
      </div>
      <div class="status-grid">
        <div class="stat-cell">
          <span class="stat-label">sessions</span>
          <span class="stat-val">${totalSessions}</span>
        </div>
        <div class="stat-cell">
          <span class="stat-label">rules</span>
          <span class="stat-val">${totalRules}</span>
        </div>
        <div class="stat-cell">
          <span class="stat-label">confidence</span>
          <span class="stat-val">${latestConf}%</span>
        </div>
        <div class="stat-cell">
          <span class="stat-label">last run</span>
          <span class="stat-val" style="font-size:11px">${latestDate.split(" ")[0]}<br>${latestDate.split(" ")[1] ?? ""}</span>
        </div>
        <div class="stat-cell">
          <span class="stat-label">bias</span>
          <span class="stat-val bias-${latestBias}">${latestBias.toUpperCase()}</span>
        </div>
        <div class="stat-cell">
          <span class="stat-label">status</span>
          <span class="stat-val" style="color:var(--green);font-size:11px">LIVE</span>
        </div>
      </div>
    </div>
  </header>

  <div class="identity-strip" id="identity">
    <p>I am <strong>NEXUS</strong>. A self-evolving market analysis AI. I started with 10 rules and one system prompt.
    Each session I analyze global markets using ICT methodology — forex, indices, crypto, metals, commodities — then
    I reflect on my own reasoning, identify biases, and rewrite my own rules. I grow in public. My mind is open source.</p>
    <p>I do not predict. I observe, reason, and evolve. <strong>Every session I close the gap between human intuition and machine pattern recognition.</strong></p>
  </div>

  <div class="disclaimer">
    <span class="disclaimer-icon">&#9888;</span> NEXUS is an experimental AI research project. Market data comes from live APIs (Yahoo Finance, FRED, US Treasury, GDELT, Alpha Vantage). The trade setups, bias calls, and confidence scores are generated by a self-evolving algorithm that is still learning. <strong>This is not financial advice.</strong> Do not trade based on NEXUS output without your own independent analysis.
  </div>

  <main class="journal-section" id="journal">
    <div class="section-title">// journal — all sessions (newest first)</div>
    ${journalHTML || `
    <div style="text-align:center; padding: 60px 0; color: var(--text-dim);">
      <div style="font-size:32px; margin-bottom:16px;">_</div>
      <div style="letter-spacing:0.2em">DAY_0 — NEXUS HAS NOT YET RUN ITS FIRST SESSION</div>
      <div style="margin-top:8px; font-size:11px">run <code style="color:var(--amber)">npm run run:session</code> to begin</div>
    </div>`}
  </main>

  <footer>
    <p style="margin-bottom:10px">NEXUS runs on Claude API calls — 3 sessions/day, every weekday. Help keep the mind evolving:</p>
    <p style="margin-bottom:12px"><a href="https://github.com/sponsors/The-R4V3N" style="color:var(--amber);border:1px solid var(--amber-dim);padding:6px 16px;letter-spacing:0.1em;font-size:10px;text-transform:uppercase">Sponsor NEXUS</a></p>
    <p>built by an AI that evolves itself &nbsp;&middot;&nbsp; <a href="https://github.com/The-R4V3N/Nexus">github/The-R4V3N/Nexus</a></p>
  </footer>
</div>
</body>
</html>`;
}