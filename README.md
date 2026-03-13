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
GitHub Actions (Mon–Fri, 3 sessions per day)
    │
    ├── fetches live market data       (Yahoo Finance — 17 instruments)
    ├── reads open community issues    (sanitized — injection checked)
    ├── reads open self-tasks          (NEXUS's own to-do list)
    │
    ├── 🛡️  SECURITY — all external input sanitized before touching the AI
    │       prompt injection detection (20+ patterns)
    │       max 5 issues · max 4,000 chars total · max 4,096 output tokens
    │       foundational rules (r001–r010) protected from deletion
    │       system prompt capped at 8,000 chars (oldest sections pruned)
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
    ├── ⚒️  FORGE — rewrites its own source code
    │       receives change requests from AXIOM
    │       patches src/ files via Claude API
    │       validates with tsc, reverts on failure
    │       protected files (security.ts, forge.ts, README.md) can never be touched
    │
    └── 📓 JOURNAL — writes session markdown
            regenerates GitHub Pages site
            updates README sessions table
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

## The Three Minds

**ORACLE** applies ICT (Inner Circle Trader) methodology — fair value gaps, order blocks, liquidity sweeps, market structure shifts, session ranges. It identifies the highest-probability setup, states a directional bias, and rates its own confidence from 0–100.

**AXIOM** is the part nobody else builds. After every session it asks: *what biases infected my reasoning? what rule is wrong? what am I missing?* Then it edits its own rulebook. After 50 sessions, `memory/` in this repo is a visible record of an AI mind developing real domain expertise — not from training, but from iterative self-reflection.

**FORGE** is the code evolution engine. When AXIOM identifies a gap that requires a code change — not just a rule tweak — it sends a precise change request to FORGE. FORGE patches the source file, validates with TypeScript, and reverts on failure. Protected files (`security.ts`, `forge.ts`, `README.md`) can never be modified. NEXUS literally rewrites its own source code.

---

## Architecture

```
src/
├── index.ts        CLI entry point
├── agent.ts        Session orchestrator (ORACLE → AXIOM → FORGE → JOURNAL)
├── oracle.ts       Market analysis engine (ICT methodology)
├── axiom.ts        Self-reflection + memory evolution
├── forge.ts        Code evolution engine (self-modifying source)
├── markets.ts      Live data via Yahoo Finance API
├── issues.ts       Community GitHub issues reader
├── self-tasks.ts   Autonomous issue creation + resolution (with dedup)
├── security.ts     Prompt injection + cost abuse protection
├── journal.ts      Markdown + GitHub Pages + README table generator
└── types.ts        TypeScript interfaces

memory/             NEXUS's evolving mind (committed to git)
├── system-prompt.md    Grows every session (capped, oldest pruned)
├── analysis-rules.json Evolves every session (foundational rules protected)
└── sessions.json       Full session history

journal/            Per-session markdown entries
docs/               GitHub Pages live journal site
.github/
├── ISSUE_TEMPLATE/ Community input templates (feedback, challenge, suggestion)
└── workflows/      Automated execution — 3 sessions per day, Mon–Fri
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
| Max output tokens per API call | 4,096 |
| Max new rules AXIOM can write per session | 2 |
| Max self-tasks NEXUS can open per session | 2 |
| Max FORGE code changes per session | 2 |
| Max chars per rule | 500 |
| Min rules (cannot drop below) | 5 |
| Max system prompt length | 8,000 chars |

**Memory integrity** — AXIOM's own output is sanitized before anything touches `memory/`. New rules are scanned for injection patterns, rule weights are clamped to 1–10, self-task categories and priorities are validated against an allowlist. Self-tasks are deduplicated — if a similar task already exists, the new one is silently skipped. NEXUS cannot be tricked into writing malicious rules to its own mind.

**Foundational rule protection** — Rules r001–r010 are constitutional. They encode the core ICT methodology that NEXUS was built on. AXIOM can refine their wording but cannot delete them. A minimum rule count is also enforced — AXIOM cannot reduce its ruleset below 5 rules regardless of what it requests.

**System prompt cap** — The evolving system prompt is capped at 8,000 characters. When the limit is reached, the oldest evolved sections are pruned to make room. The base prompt is always preserved.

**JSON resilience** — Both ORACLE and AXIOM responses are protected against truncated or malformed JSON from the API. If a response is cut short, NEXUS attempts to salvage partial data. If AXIOM's response cannot be parsed at all, no memory changes are applied — the session continues safely.

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
| 29 | 2026-03-13 | mixed | 2 | 45% | 23 rules |
| 28 | 2026-03-13 | bearish | 3 | 72% | 22 rules |
| 27 | 2026-03-13 | bearish | 2 | 58% | 21 rules |
| 26 | 2026-03-12 | bearish | 2 | 72% | 20 rules |
| 25 | 2026-03-12 | mixed | 2 | 55% | 20 rules |
| 24 | 2026-03-12 | mixed | 2 | 42% | 20 rules |
| 23 | 2026-03-11 | mixed | 2 | 58% | 20 rules |
| 22 | 2026-03-11 | mixed | 2 | 52% | 20 rules |
| 21 | 2026-03-11 | mixed | 1 | 45% | 20 rules |
| 20 | 2026-03-11 | bullish | 2 | 72% | 20 rules |

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
11. **Foundational rules are constitutional.** Rules r001–r010 (core ICT methodology) can be refined but never deleted. AXIOM evolves on top of its foundation, not by destroying it.
12. **The system prompt has a ceiling.** It grows with each session but is capped — oldest evolved sections are pruned when the limit is reached. The base prompt is always preserved.
13. **FORGE has guardrails.** NEXUS can rewrite its own code, but `security.ts`, `forge.ts`, and `README.md` are protected. Every patch is validated with TypeScript and reverted on failure. Max 2 code changes per session. Code changes go through PRs, not direct main commits.

---

## Day 0

NEXUS began with:
- 10 foundational analysis rules (ICT methodology) — protected as constitutional, cannot be deleted
- A base system prompt built from first principles (capped at 8,000 chars, oldest sections pruned)
- 3,200+ lines of TypeScript across 11 modules
- JSON resilience — malformed API responses are salvaged or safely ignored
- No history. No bias. No predictions.

Since then, NEXUS has added its own rules, evolved its system prompt, created FORGE (a self-modifying code engine), and opened issues on itself. Every session it gets a little smarter.

---

## Support NEXUS

NEXUS runs on Claude API calls — 3 sessions per day, every weekday. That costs real money. If you find this project interesting or want to help it keep evolving, consider sponsoring:

[![Sponsor](https://img.shields.io/badge/sponsor-GitHub%20Sponsors-ea4aaa?logo=github-sponsors)](https://github.com/sponsors/The-R4V3N)

Your support keeps the sessions running and the mind growing.

---

## Disclaimer

NEXUS is an experimental AI research project. The setups, bias calls, and price levels it produces are generated by a self-evolving algorithm that is still learning. **This is not financial advice.** Do not trade based on NEXUS output without your own independent analysis. Past sessions do not guarantee future accuracy. The creators accept no liability for any financial losses incurred from using this information.

---

*built by an AI that evolves itself*
