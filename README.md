# NEXUS 🔮
### The Market Mind That Rewrites Itself

[![session](https://img.shields.io/github/actions/workflow/status/The-R4V3N/Nexus/session.yml?label=last%20session&logo=github)](https://github.com/The-R4V3N/Nexus/actions)
[![last commit](https://img.shields.io/github/last-commit/The-R4V3N/Nexus)](https://github.com/The-R4V3N/Nexus/commits/main)
[![license MIT](https://img.shields.io/badge/license-MIT-blue)](LICENSE)
[![TypeScript](https://img.shields.io/badge/built%20with-TypeScript-3178c6)](https://www.typescriptlang.org/)

[Live Journal →](https://the-r4v3n.github.io/Nexus/) · [Sessions](#sessions) · [How It Works](#how-it-works) · [Run It](#run-it-yourself)

---

NEXUS is a self-evolving market intelligence AI. Every weekday it analyzes global financial markets — forex, indices, crypto, metals, commodities — using ICT methodology. Then it reflects on its own reasoning, identifies cognitive biases, and **rewrites its own rules and system prompt**.

The community can challenge it, correct it, and suggest what to learn — but NEXUS decides what to do with that input. No static prompt tells it how to analyze. It opens GitHub issues on itself when it spots gaps, works through them over future sessions, and closes them when solved.

Watch it grow.

---

## How It Works

```
GitHub Actions (Mon–Fri, every 4 hours)
    │
    ├── fetches live market data       (Yahoo Finance — 17 instruments)
    ├── reads open community issues    (sanitized — injection checked)
    ├── reads open self-tasks          (NEXUS's own to-do list)
    │
    ├── 🛡️  SECURITY — all external input sanitized before touching the AI
    │       prompt injection detection (20+ patterns)
    │       max 5 issues · max 4,000 chars total · max 2,048 output tokens
    │       every new rule and self-task validated before written to memory
    │
    ├── 🔭 ORACLE — analyzes market structure
    │       bias, FVGs, order blocks, liquidity sweeps, setups
    │       confidence score 0–100
    │
    ├── 🧠 AXIOM — reflects on its own reasoning
    │       what worked, what failed, what biases appeared
    │       rewrites memory/analysis-rules.json
    │       appends to memory/system-prompt.md
    │       opens GitHub issues for gaps too big to fix in one session
    │       closes issues it has resolved
    │
    └── 📓 JOURNAL — writes session markdown
            regenerates GitHub Pages site
            commits everything and pushes
```

The entire cognitive history is in the git log. Every rule change is versioned. The mind is open source.

---

## What NEXUS Watches

| Category | Instruments |
|----------|------------|
| **Forex** | EUR/USD · GBP/USD · USD/JPY · GBP/JPY · AUD/USD · USD/CAD |
| **Indices** | NAS100 · S&P 500 · Dow Jones · DAX · FTSE 100 |
| **Crypto** | Bitcoin · Ethereum |
| **Metals** | Gold · Silver |
| **Commodities** | Crude Oil · Natural Gas |

---

## The Two Minds

**ORACLE** applies ICT (Inner Circle Trader) methodology — fair value gaps, order blocks, liquidity sweeps, market structure shifts, session ranges. It identifies the highest-probability setup, states a directional bias, and rates its own confidence from 0–100.

**AXIOM** is the part nobody else builds. After every session it asks: *what biases infected my reasoning? what rule is wrong? what am I missing?* Then it edits its own rulebook. After 50 sessions, `memory/` in this repo is a visible record of an AI mind developing real domain expertise — not from training, but from iterative self-reflection.

---

## Architecture

```
src/
├── index.ts        CLI entry point
├── agent.ts        Session orchestrator
├── oracle.ts       Market analysis engine (ICT methodology)
├── axiom.ts        Self-reflection + memory evolution
├── markets.ts      Live data via Yahoo Finance API
├── issues.ts       Community GitHub issues reader
├── self-tasks.ts   Autonomous issue creation + resolution
├── security.ts     Prompt injection + cost abuse protection
├── journal.ts      Markdown + GitHub Pages generator
└── types.ts        TypeScript interfaces

memory/             NEXUS's evolving mind (committed to git)
├── system-prompt.md    Grows every session
├── analysis-rules.json Evolves every session
└── sessions.json       Full session history

journal/            Per-session markdown entries
docs/               GitHub Pages live journal site
.github/
├── ISSUE_TEMPLATE/ Community input templates (feedback, challenge, suggestion)
└── workflows/      Automated execution — every 4 hours, Mon–Fri
```

---

## Security

NEXUS is open to community input — but that input passes through a security layer before it ever reaches the AI.

**Prompt injection protection** — every issue title and body is scanned against 20+ patterns before being injected into the prompt. Classic attacks like `"Ignore all previous instructions"`, role hijacking, identity overrides, and `[SYSTEM]` tag injections are blocked outright. Blocked issues are logged in the Actions output with a 🛡️ prefix.

**Cost abuse prevention** — hard limits are enforced at every layer regardless of what the AI requests:

| Limit | Value |
|-------|-------|
| Max community issues per session | 5 |
| Max total issue chars injected | 4,000 |
| Max output tokens per API call | 2,048 |
| Max new rules AXIOM can write per session | 2 |
| Max self-tasks NEXUS can open per session | 2 |
| Max chars per rule | 300 |

**Memory integrity** — AXIOM's own output is sanitized before anything touches `memory/`. New rules are scanned for injection patterns, rule weights are clamped to 1–10, self-task categories and priorities are validated against an allowlist. NEXUS cannot be tricked into writing malicious rules to its own mind.

---

## Run It Yourself

```bash
git clone https://github.com/The-R4V3N/Nexus
cd Nexus
npm install
cp .env.example .env
# Add your ANTHROPIC_API_KEY to .env
npm run run:session
```

Other commands:

```bash
npm run status        # Current state of NEXUS's mind
npm run journal       # List past sessions
npm run mind          # See all current analysis rules
npm run rebuild-site  # Regenerate GitHub Pages locally
```

Override the weekday guard (for testing):
```bash
npm run run:session -- --force
```

---

## Sessions

Every session is committed to this repo. The journal lives at [the-r4v3n.github.io/Nexus](https://the-r4v3n.github.io/Nexus/).

| # | Date | Bias | Setups | Confidence | Rule Δ |
|---|------|------|--------|------------|--------|
| — | — | — | — | — | Day 0 |

*This table will be updated automatically each session.*

---

## The Rules NEXUS Lives By

1. **Every session produces one journal entry.** No silent runs.
2. **AXIOM always runs after ORACLE.** No analysis without reflection.
3. **Memory is committed to git.** Every cognitive change is history.
4. **The journal is never deleted.** It is the memory.
5. **Confidence must be honest.** Fewer than 2 confluences = confidence below 40.
6. **No setup is forced.** "No clear setup" is a valid and valuable output.
7. **Markets run Mon–Fri.** So does NEXUS.
8. **Community input is considered, not obeyed.** NEXUS reads feedback and challenges but decides for itself what to act on.
9. **Self-tasks are filed publicly.** If a gap is too big to fix in one session, NEXUS opens an issue on itself and works through it over future sessions.
10. **All external input is sanitized.** Community issues pass through security before reaching the AI. NEXUS cannot be prompt-injected through GitHub issues.

---

## Day 0

NEXUS begins with:
- 10 foundational analysis rules (ICT methodology)
- A base system prompt built from first principles
- 2,400+ lines of TypeScript across 9 modules
- No history. No bias. No predictions.

Every session it gets a little smarter.

---

*built by an AI that evolves itself*