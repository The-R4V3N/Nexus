# NEXUS — Developer Guide

## What This Is

NEXUS is a self-evolving market intelligence AI. It runs 5 automated sessions per day (Mon-Fri, aligned to market opens via GitHub Actions) that analyze 17 financial instruments using ICT methodology, then reflects on its own reasoning, rewrites its own rules and system prompt, and can even rewrite its own source code.

## Architecture

```
src/
  index.ts        CLI entry point (commander)
  agent.ts        Session orchestrator — runs the full pipeline
  oracle.ts       Market analysis engine (calls Claude API with ICT methodology)
  axiom.ts        Self-reflection engine — rewrites rules + system prompt
  forge.ts        Code evolution engine (self-modifying source via Claude API)
  markets.ts      Live data via Yahoo Finance v8 API (no package, raw HTTP)
  issues.ts       Community GitHub issues reader (nexus-input label)
  self-tasks.ts   Autonomous issue creation + resolution (nexus-self-task label, with dedup)
  security.ts     Prompt injection detection, cost guards, output sanitization, meta-rule blocking
  journal.ts      Markdown journal + GitHub Pages HTML + README table auto-update
  types.ts        All TypeScript interfaces

memory/           NEXUS's evolving mind (committed to git)
  system-prompt.md    Base + evolved system prompt (grows each session, capped at 8000 chars)
  analysis-rules.json Evolving ruleset (JSON, versioned)
  sessions.json       Full session history (array of JournalEntry)

journal/          Per-session markdown files
docs/             GitHub Pages site (index.html regenerated each session)
```

## Session Pipeline

1. **Market Data** — `fetchAllMarkets()` pulls 17 instruments from Yahoo Finance
2. **Community Issues** — fetches GitHub issues labeled `nexus-input`, sanitized through security
3. **Self-Tasks** — fetches open issues labeled `nexus-self-task` (deduplicated)
4. **ORACLE** — Claude API call with market data + rules + system prompt → structured JSON analysis (rules embedded in prompt)
5. **AXIOM** — Claude API call reflecting on ORACLE's output → rule updates, new rules, system prompt additions, self-tasks, FORGE change requests. Includes compliance check summary to prevent stale self-criticism.
6. **FORGE** — Applies AXIOM's code change requests. Patches `src/` files via Claude API, validates with `tsc`, reverts on failure. Protected files: `security.ts`, `forge.ts`, `session.yml`, `README.md`. Max 2 changes per session. Code changes go through PRs, not direct main commits.
7. **Journal** — writes markdown + updates GitHub Pages HTML + auto-updates README sessions table
8. **Commit** — GitHub Actions commits memory/journal/docs changes to main; FORGE src/ changes go to a dedicated branch with a PR

## Key Design Decisions

- **Claude Sonnet** is used for ORACLE, AXIOM, and FORGE calls (`claude-sonnet-4-20250514`)
- **No external market data packages** — raw Yahoo Finance v8 API via `fetch()`
- **Memory is git-versioned** — every cognitive change is a commit
- **Security-first community input** — all issues pass through `sanitizeAllIssues()` before touching the prompt
- **Foundational rules (r001-r010)** are constitutional — AXIOM can modify their wording but cannot delete them
- **System prompt is capped** at 8000 chars — oldest evolved sections are pruned when limit is reached
- **Minimum 5 rules** enforced — AXIOM cannot reduce the ruleset below this threshold
- **Meta-rule blocking** — security.ts blocks rules that reference 2+ other rules with enforcement keywords, preventing self-referential rule spirals
- **Self-task deduplication** — normalized word overlap (>70%) prevents duplicate issues from being created
- **FORGE code changes go through PRs** — src/ changes are committed to a dedicated branch and a PR is opened for review, not pushed directly to main
- **README.md is FORGE-protected** — FORGE cannot modify the README to prevent formatting damage

## Security Model

All external input passes through `security.ts` before reaching the AI:

- **Prompt injection**: 20+ regex patterns block classic attacks (instruction override, role hijack, jailbreak tokens)
- **Cost limits**: max 5 issues, 4000 total chars, 4096 output tokens per API call, max 2 FORGE changes per session
- **AXIOM output sanitization**: new rules checked for injection, weights clamped 1-10, self-task categories/priorities validated against allowlists
- **Meta-rule blocking**: rules referencing 2+ other rules with enforcement keywords are blocked to prevent self-referential spirals
- **Self-task deduplication**: normalized word overlap >70% prevents duplicate issues
- **Foundational rule protection**: rules r001-r010 cannot be removed, minimum rule count enforced
- **FORGE file protection**: `security.ts`, `forge.ts`, `session.yml`, `README.md` can never be modified by FORGE

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
- Optional `GITHUB_TOKEN` for issue reading/writing
- Optional `GITHUB_REPOSITORY` (defaults to `The-R4V3N/Nexus`)

### TypeScript
- `strict: false` in tsconfig — the codebase uses `any` for API responses
- Run with `ts-node` (transpileOnly, commonjs)
- Target: ES2020

## Rules for Contributing

- Never delete or overwrite `memory/` files without understanding the session history
- The `memory/analysis-rules.json` foundational rules (r001-r010) must always be preserved
- Security patterns in `security.ts` should only be added to, never relaxed
- The ORACLE → AXIOM → Journal pipeline order is invariant — AXIOM must always run after ORACLE
- Journal entries are append-only — never delete past sessions
- All community input must pass through `sanitizeAllIssues()` before prompt injection
- HTML in `journal.ts` is inline (no external CSS/JS) — the site must work as a single file on GitHub Pages
