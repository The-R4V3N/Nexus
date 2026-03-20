# NEXUS — Developer Guide

## What This Is

NEXUS is a self-evolving market intelligence AI. It runs 3 automated sessions per day (Mon-Fri, aligned to market opens via GitHub Actions) that analyze 45 financial instruments using ICT methodology, then reflects on its own reasoning, rewrites its own rules and system prompt, and can even rewrite its own source code.

## Architecture

```text
src/
  index.ts        CLI entry point (commander)
  agent.ts        Session orchestrator — runs the full defensive pipeline
  oracle.ts       Market analysis engine (calls Claude API with ICT methodology)
  axiom.ts        Self-reflection engine — rewrites rules + system prompt
  forge.ts        Code evolution engine (self-modifying source via Claude API)
  validate.ts     Quality gates — ORACLE + AXIOM output validation, recycled content detection
  markets.ts      Live data via Yahoo Finance v8 API (no package, raw HTTP)
  macro.ts        Macro & geopolitical data (FRED, US Treasury, GDELT, Alpha Vantage — all raw HTTP)
  issues.ts       Community GitHub issues reader (nexus-input label)
  self-tasks.ts   Autonomous issue creation + resolution (nexus-self-task label, with dedup)
  security.ts     Prompt injection detection, cost guards, output sanitization, meta-rule blocking
  journal.ts      Markdown journal + GitHub Pages HTML + README table auto-update
  types.ts        All TypeScript interfaces
  utils.ts        Shared utilities (salvageJSON, stripSurrogates, extractJSON, path constants, groupBy)

config/
  forex.json          24 forex pairs (majors + crosses)
  indices.json        5 major indices
  crypto.json         10 cryptocurrencies
  commodities.json    6 commodities (metals, energy)

memory/           NEXUS's evolving mind (committed to git)
  system-prompt.md    Base + evolved system prompt (grows each session, capped at 8000 chars)
  analysis-rules.json Evolving ruleset (JSON, versioned)
  sessions.json       Full session history (array of JournalEntry)
  failures.json       Persistent failure log (capped at 20, fed back to AXIOM)

journal/          Per-session markdown files
docs/             GitHub Pages site (index.html regenerated each session)
NEXUS_IDENTITY.md Constitutional identity document (immutable, loaded into AXIOM prompt)
```

## Session Pipeline

1. **Pre-flight Check** — `tsc --noEmit` validates the codebase compiles before anything runs
2. **Git Snapshot** — captures `HEAD` SHA for session-level rollback on unhandled crashes
3. **Data Fetch (parallel)** — `fetchAllInputData()` pulls market data (45 instruments from Yahoo Finance), macro data (FRED, Treasury, GDELT, Alpha Vantage), community issues, and self-tasks simultaneously via `Promise.allSettled()`. Market data failure halts the session; other sources degrade gracefully.
4. **ORACLE** — Two sequential Claude API calls: (1) ORACLE-ANALYSIS produces market narrative, bias, confidence, and key levels; (2) ORACLE-SETUPS receives the analysis + all instrument prices and constructs precise entry/stop/target setups. Max 8192 output tokens per call. Truncated responses are salvaged via field-boundary cut points.
5. **ORACLE Validation Gate** — `validateOracleOutput()` checks analysis length, confidence range, bias validity, setup sanity, and recycled content detection (>80% Jaccard similarity blocks). Confidence consistency enforced: narrative calculation overrides JSON when divergence >10 points. Confidence >60% with zero setups forces confidence to 35%. Bias notes enforced as non-empty. R:R < 1.0 flagged. Session halts on validation failure.
6. **AXIOM** — Claude API call reflecting on ORACLE's output → rule updates, new rules, system prompt additions, self-tasks, FORGE change requests. Receives failure history (last 5 failures from `memory/failures.json`), setup outcome tracking (previous setups vs current prices), stagnation alerts (when 3+ consecutive sessions have zero rule changes), and NEXUS_IDENTITY.md as constitutional context.
7. **AXIOM Validation Gate** — `validateAxiomOutput()` checks required fields, array types, recycled reflection detection (>70%), and rule ID format. Falls back to empty reflection on failure.
8. **FORGE** — Applies AXIOM's code change requests. Patches `src/` files via Claude API, validates with `tsc`, reverts on failure. Protected files: `security.ts`, `forge.ts`, `session.yml`, `README.md`. Max 2 changes per session, max 200 lines per patch. Code changes go through PRs, not direct main commits.
9. **FORGE Protected File Enforcement** — `git diff` verifies no protected files were modified after FORGE runs
10. **Journal** — writes markdown + updates GitHub Pages HTML + auto-updates README sessions table
11. **Commit** — GitHub Actions commits memory/journal/docs changes to main; FORGE src/ changes go to a dedicated branch with a PR
12. **Crash Rollback** — on unhandled exceptions, `git checkout -- .` reverts to the pre-session snapshot and the failure is logged to `memory/failures.json`

## Key Design Decisions

- **Claude Sonnet** is used for ORACLE, AXIOM, and FORGE calls (`claude-sonnet-4-20250514`)
- **No external market data packages** — raw Yahoo Finance v8 API, FRED, US Treasury, and GDELT APIs via `fetch()`
- **Macro data is optional** — FRED requires a free API key (`FRED_API_KEY`), Alpha Vantage requires a free API key (`ALPHA_VANTAGE_API_KEY`), Treasury and GDELT need no auth. All sources degrade gracefully on failure
- **Memory is git-versioned** — every cognitive change is a commit
- **Security-first community input** — all issues pass through `sanitizeAllIssues()` before touching the prompt
- **Foundational rules (r001-r010)** are constitutional — AXIOM can modify their wording but cannot delete them
- **System prompt is capped** at 8000 chars — oldest evolved sections are pruned when limit is reached
- **Minimum 5 rules** enforced — AXIOM cannot reduce the ruleset below this threshold
- **Meta-rule blocking** — security.ts blocks rules that reference 2+ other rules with enforcement keywords, preventing self-referential rule spirals
- **Self-task deduplication** — normalized word overlap (>70%) prevents duplicate issues from being created
- **FORGE code changes go through PRs** — src/ changes are committed to a dedicated branch and a PR is opened for review, not pushed directly to main
- **README.md is FORGE-protected** — FORGE cannot modify the README to prevent formatting damage
- **Constitutional identity** — `NEXUS_IDENTITY.md` defines immutable boundaries; loaded into AXIOM's system prompt, protected from modification by FORGE and GitHub Actions
- **Quality gates** — ORACLE and AXIOM outputs are validated before entering memory; recycled content is detected via Jaccard word-overlap similarity
- **Session-level rollback** — unhandled crashes revert all uncommitted changes via `git checkout -- .`
- **Failure feedback loop** — `memory/failures.json` stores recent failures (capped at 20) and feeds them back into AXIOM context so NEXUS learns from its own crashes
- **Stagnation detection** — consecutive no-change streaks are counted from session history; 3+ triggers a mandatory evolution alert in AXIOM's prompt
- **Anti-rumination enforcement** — repeated critiques detected via word-overlap; after 3+ sessions of the same critique without rule/self-task/code action, system prompt additions are blocked to force concrete action
- **Setup outcome tracking** — previous session setups are compared against current market prices to report STOPPED OUT / TARGET HIT / OPEN outcomes
- **Conditional version bumps** — `analysis-rules.json` version and lastUpdated only change when rules actually change, preventing false evolution signals
- **GitHub Actions retry** — session step retries once with a 2-minute backoff on failure
- **Sessions.json capped at 500 entries** — prevents unbounded growth; oldest entries pruned when limit exceeded
- **Journal entries cached per session** — `loadAllJournalEntries()` uses in-process cache, invalidated on save, eliminating redundant disk reads
- **Externalized instruments** — `config/instruments.json` defines the 17 tracked instruments; `markets.ts` falls back to hardcoded defaults if the file is missing
- **Fetch timeouts on all external calls** — 10s for market data, 15s for macro data, 20s for GitHub API; prevents session hangs when APIs are unresponsive
- **Phase 1 data fetches parallelized** — market data, macro data, community issues, and self-tasks are fetched simultaneously via `Promise.allSettled()`

## Security Model

All external input passes through `security.ts` before reaching the AI:

- **Prompt injection**: 20+ regex patterns block classic attacks (instruction override, role hijack, jailbreak tokens)
- **Cost limits**: max 5 issues, 4000 total chars, max 2 FORGE changes per session, max 200 lines per FORGE patch
- **ORACLE token limit**: ORACLE has its own centralized token limit (`MAX_ORACLE_OUTPUT_TOKENS = 8192`) via `getMaxOracleOutputTokens()` in `security.ts`, separate from the default `MAX_OUTPUT_TOKENS = 4096` used by AXIOM/FORGE
- **AXIOM output sanitization**: new rules checked for injection, weights clamped 1-10, self-task categories/priorities validated against allowlists
- **Meta-rule blocking**: rules referencing 2+ other rules with enforcement keywords are blocked to prevent self-referential spirals
- **Self-task deduplication**: normalized word overlap >70% prevents duplicate issues
- **Foundational rule protection**: rules r001-r010 cannot be removed, minimum rule count enforced
- **FORGE file protection**: `security.ts`, `forge.ts`, `session.yml`, `README.md` can never be modified by FORGE; files with `security` or `forge` prefixes are also blocked
- **FORGE content safety**: AI-generated code is scanned by `isCodeSafe()` before writing to disk — blocks secret exfiltration, child_process, exec, filesystem mutations, and eval
- **Macro data sanitization**: GDELT article fields and Alpha Vantage ticker data are sanitized via `sanitizeMacroText()` against injection patterns before entering the ORACLE prompt
- **Error log sanitization**: API keys are stripped from error messages via `sanitizeErrorMessage()` before logging

## Working With the Code

### Commands

```bash
npm run run:session          # Run full session (weekdays only)
npm run run:session -- --force  # Run even on weekends
npm run status               # Current memory state
npm run journal              # List past sessions
npm run mind                 # Show current analysis rules
npm run rebuild-site         # Regenerate GitHub Pages
```

### Environment

- Requires `ANTHROPIC_API_KEY` in `.env`
- Optional `FRED_API_KEY` for macro economic indicators (free at <https://fred.stlouisfed.org/docs/api/api_key.html>)
- Optional `ALPHA_VANTAGE_API_KEY` for technical indicators and market movers (free at <https://www.alphavantage.co/support/#api-key>)
- Optional `GITHUB_TOKEN` for issue reading/writing
- Optional `GITHUB_REPOSITORY` (defaults to `The-R4V3N/Nexus`)

### TypeScript

- `strict: false` in tsconfig — the codebase uses `any` for API responses
- Run with `ts-node` (transpileOnly, commonjs)
- Target: ES2020

## Bug Fixing Protocol

When a bug is reported, do not start by trying to fix it. Instead:

1. Write a test that reproduces the bug (prove it fails)
2. Delegate the fix to subagents who must prove their fix works by making the test pass
3. Only consider the bug fixed when the reproduction test passes

## Rules for Contributing

- Never delete or overwrite `memory/` files without understanding the session history
- The `memory/analysis-rules.json` foundational rules (r001-r010) must always be preserved
- Security patterns in `security.ts` should only be added to, never relaxed
- The ORACLE → AXIOM → Journal pipeline order is invariant — AXIOM must always run after ORACLE
- Journal entries are append-only — never delete past sessions
- All community input must pass through `sanitizeAllIssues()` before prompt injection
- HTML in `journal.ts` is inline (no external CSS/JS) — the site must work as a single file on GitHub Pages
