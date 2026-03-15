# Code Review Fixes — 2026-03-15

Findings from architecture, security, and performance review.

## Critical

- [x] **FORGE content safety scan** — `isCodeSafe()` scans for dangerous patterns before writing to disk
- [x] **ORACLE max_tokens bypass** — centralized via `getMaxOracleOutputTokens()` in security.ts

## High — Security

- [x] **Sanitize macro data for prompt injection** — `sanitizeMacroText()` checks GDELT/Alpha Vantage fields against injection patterns
- [x] **Strengthen FORGE protected file checks** — `PROTECTED_PREFIXES` blocks security-/forge- filenames, backslash path traversal check added
- [x] **Fix FORGE line-count metric** — now counts actual diff lines via set comparison, not net line change
- [x] **Strip API keys from error logs** — `sanitizeErrorMessage()` redacts api_key params before logging
- [x] **Document GITHUB_TOKEN scope** — documented in CLAUDE.md Security Model section

## High — Architecture

- [x] **Extract shared utilities into `src/utils.ts`** — salvageJSON, stripSurrogates, extractJSONFromResponse, path constants, groupBy
- [x] **Cache `loadAllJournalEntries()` per session** — in-process cache with invalidation on save

## High — Performance

- [x] **Add `AbortSignal.timeout()` to all fetch calls** — 10s markets, 15s macro, 20s GitHub API
- [x] **Parallelize Phase 1 data fetches** — markets, macro, issues, self-tasks via Promise.allSettled

## High — Testing

- [x] **Add tests for core modules** — forge.ts (28 tests), utils.ts (25 tests), expanded security + macro tests

## Medium — Security

- [x] **ReDoS mitigation** — bounded `\s+` to `\s{1,10}` in injection patterns
- [x] **GitHub Pages XSS** — bias values allowlisted before using in HTML attributes
- [x] **Sanitize resolvedSelfTasks comments** — issueNumber validated as positive int, comment HTML stripped and capped at 500 chars

## Medium — Code Quality

- [x] **Fix crash handler phase label** — `currentPhase` variable tracks actual phase in runSession()
- [ ] **Break up `runSession()`** — 325-line God function, extract into phase functions (deferred)
- [ ] **Break up `runAxiomReflection()`** — 315-line function (deferred)
- [x] **Cap `sessions.json`** — capped to last 500 entries (~8 months at 3/day)
- [x] **Empty catch blocks** — added debug logging to all 9 empty catch blocks in agent.ts and axiom.ts

## Low

- [x] **Use `npm ci` in GitHub Actions** — changed from `npm install`
- [x] **Add `dist/` to .gitignore** — added
- [ ] **Externalize instrument list** — 17 instruments hardcoded in markets.ts (deferred)
- [x] **TruffleHog unverified secrets** — removed `--only-verified` flag
