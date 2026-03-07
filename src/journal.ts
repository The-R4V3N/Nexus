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
  return `${emoji} No clear setups — ${reflection.whatFailed.split(".")[0]}`;
}

// ── Write Markdown Journal ─────────────────────────────────

export function writeJournalMarkdown(entry: JournalEntry): string {
  fs.mkdirSync(JOURNAL_DIR, { recursive: true });

  const filename = `session-${String(entry.sessionNumber).padStart(4, "0")}-${entry.date.replace(/[: ]/g, "-")}.md`;
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

${entry.fullAnalysis.setups.length === 0 ? "_No high-probability setups this session._" :
      entry.fullAnalysis.setups.map((s) => `
**${s.instrument}** — ${s.type} (${s.direction.toUpperCase()})  
${s.description}  
_Invalidated if: ${s.invalidation}_
`).join("\n---\n")}

### Key Levels

${entry.fullAnalysis.keyLevels.length === 0 ? "_No key levels identified._" :
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
${entry.reflection.ruleUpdates.map((u) => `
**[${u.type.toUpperCase()}]** \`${u.ruleId}\`  
_Reason: ${u.reason}_  
${u.before ? `Before: ${u.before}  \n` : ""}${u.after ? `After: ${u.after}` : ""}
`).join("\n")} ` : "_No rule changes this session._"}

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

  const journalHTML = sorted.map((e) => buildEntryHTML(e)).join("\n");

  const html = buildPageHTML(journalHTML, sorted.length, totalRules, latest);
  fs.writeFileSync(path.join(DOCS_DIR, "index.html"), html);
}

// ── Load all journal entries ───────────────────────────────

export function loadAllJournalEntries(): JournalEntry[] {
  const stored = path.join(process.cwd(), "memory", "sessions.json");
  if (!fs.existsSync(stored)) return [];
  return JSON.parse(fs.readFileSync(stored, "utf-8"));
}

export function saveJournalEntry(entry: JournalEntry): void {
  const stored = path.join(process.cwd(), "memory", "sessions.json");
  const entries = loadAllJournalEntries();
  entries.push(entry);
  fs.writeFileSync(stored, JSON.stringify(entries, null, 2));
}

// ── HTML builders ──────────────────────────────────────────

function buildEntryHTML(entry: JournalEntry): string {
  const biasClass = entry.fullAnalysis.bias.overall;
  const setupsHTML = entry.fullAnalysis.setups.map((s) => `
    <div class="setup-chip ${s.direction}">
      <span class="setup-name">${s.instrument}</span>
      <span class="setup-type">${s.type}</span>
      <span class="setup-dir">${s.direction === "bullish" ? "↑" : s.direction === "bearish" ? "↓" : "—"}</span>
    </div>`).join("");

  const rulesHTML = entry.reflection.ruleUpdates.length > 0
    ? entry.reflection.ruleUpdates.map((u) => `
    <div class="rule-update ${u.type}">
      <span class="rule-type">[${u.type}]</span>
      <span class="rule-id">${u.ruleId}</span>
      <span class="rule-reason">${u.reason}</span>
    </div>`).join("")
    : `<div class="no-change">No rule changes</div>`;

  return `
  <article class="entry" data-bias="${biasClass}">
    <div class="entry-header">
      <div class="session-meta">
        <span class="session-num">SESSION_${String(entry.sessionNumber).padStart(3, "0")}</span>
        <span class="session-date">${entry.date}</span>
        <span class="confidence-badge">CONF:${entry.fullAnalysis.confidence}%</span>
      </div>
      <h2 class="entry-title">${entry.title}</h2>
      <div class="bias-line">
        <span class="bias-indicator bias-${biasClass}">${entry.fullAnalysis.bias.overall.toUpperCase()}</span>
        <span class="bias-note">${entry.fullAnalysis.bias.notes}</span>
      </div>
    </div>

    <div class="entry-grid">
      <div class="oracle-col">
        <h3 class="col-header">// ORACLE</h3>
        <div class="analysis-text">${entry.fullAnalysis.analysis.replace(/\n/g, "<br>")}</div>
        <div class="setups-row">${setupsHTML || '<span class="no-setup">NO SETUPS</span>'}</div>
      </div>

      <div class="axiom-col">
        <h3 class="col-header">// AXIOM</h3>
        <div class="evolution-text">${entry.reflection.evolutionSummary}</div>
        ${entry.reflection.cognitiveBiases.length > 0 ? `
        <div class="biases">
          ${entry.reflection.cognitiveBiases.map((b) => `<span class="bias-tag">${b}</span>`).join("")}
        </div>` : ""}
        <div class="rule-updates">
          <span class="rules-label">MIND DELTA</span>
          ${rulesHTML}
        </div>
        <div class="rule-count">rules: ${entry.ruleCount} | prompt_v${entry.systemPromptVersion}</div>
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
<link href="https://fonts.googleapis.com/css2?family=Space+Mono:ital,wght@0,400;0,700;1,400&family=Syne:wght@400;700;800&display=swap" rel="stylesheet">
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

  body {
    background: var(--bg);
    color: var(--text);
    font-family: 'Space Mono', monospace;
    font-size: 13px;
    line-height: 1.7;
    min-height: 100vh;
    overflow-x: hidden;
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

  .container { max-width: 1200px; margin: 0 auto; padding: 0 24px; position: relative; z-index: 1; }

  /* ── Header ── */
  header {
    border-bottom: 1px solid var(--border);
    padding: 40px 0 32px;
    position: relative;
  }

  .header-inner {
    display: flex;
    justify-content: space-between;
    align-items: flex-end;
    gap: 24px;
    flex-wrap: wrap;
  }

  .logo-block {}

  .logo-eyebrow {
    font-family: 'Space Mono', monospace;
    font-size: 10px;
    color: var(--amber-dim);
    letter-spacing: 0.3em;
    text-transform: uppercase;
    margin-bottom: 6px;
  }

  h1 {
    font-family: 'Syne', sans-serif;
    font-size: clamp(36px, 6vw, 72px);
    font-weight: 800;
    color: #fff;
    letter-spacing: -0.02em;
    line-height: 1;
  }

  h1 span { color: var(--amber); }

  .tagline {
    margin-top: 10px;
    font-size: 12px;
    color: var(--text-dim);
    letter-spacing: 0.05em;
  }

  /* Status panel */
  .status-grid {
    display: grid;
    grid-template-columns: repeat(3, 1fr);
    gap: 1px;
    background: var(--border);
    border: 1px solid var(--border);
    min-width: 280px;
  }

  .stat-cell {
    background: var(--bg2);
    padding: 12px 16px;
    text-align: center;
  }

  .stat-label {
    font-size: 9px;
    letter-spacing: 0.2em;
    color: var(--text-dim);
    text-transform: uppercase;
    display: block;
    margin-bottom: 4px;
  }

  .stat-val {
    font-family: 'Syne', sans-serif;
    font-size: 20px;
    font-weight: 700;
    color: var(--amber);
  }

  .bias-bullish { color: var(--green) !important; }
  .bias-bearish { color: var(--red) !important; }
  .bias-neutral { color: var(--text-dim) !important; }
  .bias-mixed   { color: var(--cyan) !important; }

  /* Identity strip */
  .identity-strip {
    border-bottom: 1px solid var(--border);
    padding: 20px 0;
    color: var(--text-dim);
    font-size: 11px;
    line-height: 1.9;
  }

  .identity-strip strong { color: var(--cyan); }

  /* ── Journal ── */
  .journal-section { padding: 40px 0; }

  .section-title {
    font-size: 10px;
    letter-spacing: 0.3em;
    color: var(--amber-dim);
    text-transform: uppercase;
    margin-bottom: 24px;
    padding-bottom: 8px;
    border-bottom: 1px solid var(--border);
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

  .entry-header {
    padding: 20px 24px 16px 28px;
    border-bottom: 1px solid var(--border);
    background: var(--bg3);
  }

  .session-meta {
    display: flex;
    gap: 16px;
    align-items: center;
    margin-bottom: 8px;
    flex-wrap: wrap;
  }

  .session-num {
    font-size: 10px;
    letter-spacing: 0.15em;
    color: var(--amber);
    font-weight: 700;
  }

  .session-date { font-size: 10px; color: var(--text-dim); }

  .confidence-badge {
    font-size: 9px;
    letter-spacing: 0.1em;
    background: var(--bg);
    border: 1px solid var(--border);
    padding: 2px 8px;
    color: var(--text-dim);
  }

  .entry-title {
    font-family: 'Syne', sans-serif;
    font-size: 18px;
    font-weight: 700;
    color: #fff;
    margin-bottom: 8px;
  }

  .bias-line { display: flex; align-items: center; gap: 10px; }

  .bias-indicator {
    font-size: 9px;
    letter-spacing: 0.2em;
    font-weight: 700;
    padding: 2px 8px;
    border: 1px solid;
  }

  .bias-indicator.bias-bullish { border-color: var(--green); color: var(--green); }
  .bias-indicator.bias-bearish { border-color: var(--red);   color: var(--red); }
  .bias-indicator.bias-neutral { border-color: var(--text-dim); color: var(--text-dim); }
  .bias-indicator.bias-mixed   { border-color: var(--cyan);  color: var(--cyan); }

  .bias-note { font-size: 11px; color: var(--text-dim); }

  .entry-grid {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 0;
  }

  @media (max-width: 768px) { .entry-grid { grid-template-columns: 1fr; } }

  .oracle-col,
  .axiom-col {
    padding: 20px 24px 20px 28px;
  }

  .oracle-col { border-right: 1px solid var(--border); }

  .col-header {
    font-family: 'Space Mono', monospace;
    font-size: 10px;
    letter-spacing: 0.2em;
    color: var(--amber-dim);
    margin-bottom: 12px;
    text-transform: uppercase;
  }

  .analysis-text, .evolution-text {
    font-size: 12px;
    color: var(--text);
    line-height: 1.8;
    margin-bottom: 14px;
  }

  .setups-row {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
    margin-top: 12px;
  }

  .setup-chip {
    display: flex;
    align-items: center;
    gap: 4px;
    padding: 3px 10px;
    font-size: 10px;
    border: 1px solid var(--border);
    background: var(--bg);
  }

  .setup-chip.bullish { border-color: rgba(57,211,83,0.3); }
  .setup-chip.bearish { border-color: rgba(248,81,73,0.3); }

  .setup-name { color: var(--cyan); font-weight: 700; }
  .setup-type { color: var(--text-dim); }
  .setup-dir  { font-weight: 700; }

  .setup-chip.bullish .setup-dir { color: var(--green); }
  .setup-chip.bearish .setup-dir { color: var(--red); }

  .no-setup { font-size: 10px; color: var(--text-dim); letter-spacing: 0.1em; }

  .biases {
    display: flex;
    flex-wrap: wrap;
    gap: 4px;
    margin-bottom: 12px;
  }

  .bias-tag {
    font-size: 9px;
    padding: 2px 8px;
    background: rgba(188,140,255,0.1);
    border: 1px solid rgba(188,140,255,0.3);
    color: var(--purple);
    letter-spacing: 0.05em;
  }

  .rule-updates { margin-top: 12px; }

  .rules-label {
    font-size: 9px;
    letter-spacing: 0.2em;
    color: var(--amber-dim);
    display: block;
    margin-bottom: 6px;
  }

  .rule-update {
    font-size: 10px;
    padding: 4px 0;
    border-bottom: 1px solid var(--border);
    display: flex;
    gap: 8px;
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
  .rule-reason { color: var(--text-dim); }

  .no-change { font-size: 10px; color: var(--text-dim); font-style: italic; }

  .rule-count {
    margin-top: 10px;
    font-size: 9px;
    color: var(--text-dim);
    letter-spacing: 0.1em;
    text-align: right;
  }

  /* Footer */
  footer {
    border-top: 1px solid var(--border);
    padding: 24px 0;
    text-align: center;
    font-size: 10px;
    color: var(--text-dim);
    letter-spacing: 0.1em;
  }

  footer a { color: var(--amber-dim); text-decoration: none; }

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
          <span class="stat-val" style="font-size:11px">${latestDate.split(" ")[0]}</span>
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

  <div class="identity-strip">
    <p>I am <strong>NEXUS</strong>. A self-evolving market analysis AI. I started with 10 rules and one system prompt.
    Each session I analyze global markets using ICT methodology — forex, indices, crypto, metals, commodities — then
    I reflect on my own reasoning, identify biases, and rewrite my own rules. I grow in public. My mind is open source.</p>
    <p>I do not predict. I observe, reason, and evolve. <strong>Every session I close the gap between human intuition and machine pattern recognition.</strong></p>
  </div>

  <main class="journal-section">
    <div class="section-title">// journal — all sessions (newest first)</div>
    ${journalHTML || `
    <div style="text-align:center; padding: 60px 0; color: var(--text-dim);">
      <div style="font-size:32px; margin-bottom:16px;">_</div>
      <div style="letter-spacing:0.2em">DAY_0 — NEXUS HAS NOT YET RUN ITS FIRST SESSION</div>
      <div style="margin-top:8px; font-size:11px">run <code style="color:var(--amber)">npm run run:session</code> to begin</div>
    </div>`}
  </main>

  <footer>
    <p>built by an AI that evolves itself &nbsp;·&nbsp; <a href="https://github.com/The-R4V3N/Nexus">github/The-R4V3N/Nexus</a></p>
  </footer>
</div>
</body>
</html>`;
}