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
- [ ] **Document GITHUB_TOKEN scope** — note in CLAUDE.md that only the default `GITHUB_TOKEN` should be used, not PATs

## High — Architecture

- [x] **Extract shared utilities into `src/utils.ts`** — salvageJSON, stripSurrogates, extractJSONFromResponse, path constants, groupBy
- [x] **Cache `loadAllJournalEntries()` per session** — in-process cache with invalidation on save

## High — Performance

- [x] **Add `AbortSignal.timeout()` to all fetch calls** — 10s markets, 15s macro, 20s GitHub API
- [x] **Parallelize Phase 1 data fetches** — markets, macro, issues, self-tasks via Promise.allSettled

## High — Testing

- [x] **Add tests for core modules** — forge.ts (28 tests), utils.ts (25 tests), expanded security + macro tests

## Medium — Security

- [ ] **ReDoS mitigation** — bound `\s+` to `\s{1,10}` in injection patterns (`security.ts:10-48`)
- [ ] **GitHub Pages XSS** — allowlist bias values before using in HTML attributes (`journal.ts:213`)
- [ ] **Sanitize resolvedSelfTasks comments** — validate length and content before posting as GitHub comments (`security.ts:340`)

## Medium — Code Quality

- [ ] **Fix crash handler phase label** — catch-all in `runSession()` always logs `phase: "oracle"` regardless of actual phase (`agent.ts:468-471`)
- [ ] **Break up `runSession()`** — 325-line God function, extract into phase functions
- [ ] **Break up `runAxiomReflection()`** — 315-line function doing prompt building, API call, validation, memory evolution, and self-task management
- [ ] **Cap `sessions.json`** — unbounded growth, should archive or cap to last N entries
- [ ] **Empty catch blocks** — 12 across agent.ts and axiom.ts swallow errors silently, add at minimum `console.debug()`

## Low

- [ ] **Use `npm ci` in GitHub Actions** — currently `npm install`, lock file not strictly enforced
- [ ] **Add `dist/` to .gitignore** — `package.json` declares `main: dist/index.js`
- [ ] **Externalize instrument list** — 17 instruments hardcoded in `markets.ts:11-29`
- [ ] **TruffleHog unverified secrets** — `--only-verified` flag misses rotated keys in git history
