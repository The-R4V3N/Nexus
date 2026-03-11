# NEXUS Roadmap

## Current State (v1 — Sessions 1–17)

NEXUS receives one **price snapshot** per instrument per session: price, previous close, change%, high, low, volume. It runs 3 sessions per day aligned to major market opens (Asia, London, NY).

### What works now
- Cross-asset sentiment analysis (risk-on/risk-off classification)
- Session range breakouts (Asian high/low → London sweep)
- Previous session level tests (support/resistance from memory)
- Momentum classification (SD-based move sizing)
- Multi-session structure (tracking bias across sessions)
- Confidence formula (TC×0.4 + MA×0.3 + RR×0.3)
- Complete setup specs (entry/stoploss/target/RR/timeframe)

### What's missing for true ICT methodology
NEXUS claims to use ICT concepts but currently **cannot detect**:
- **Fair Value Gaps** — requires 3 consecutive candles (candle 1 high < candle 3 low = bullish FVG)
- **Order Blocks** — requires identifying the last opposing candle before a displacement move
- **Breaker Blocks** — failed order blocks that flip from support to resistance
- **Market Structure Shifts** — needs swing high/low identification across multiple candles
- **Kill Zones** — needs intraday candle data during specific session times
- **Displacement** — needs to measure candle body size vs range across a sequence

---

## Phase 1 — Historical Candle Data

**Goal:** Give NEXUS access to multi-timeframe candle data so it can actually perform ICT analysis.

### What to build
- Extend `markets.ts` to fetch historical OHLCV bars from Yahoo Finance v8 API
- Fetch two timeframes per instrument:
  - **Daily (1D)** — last 20 candles for HTF structure
  - **Hourly (1H)** — last 24 candles for intraday analysis
- Store as structured data: `{ open, high, low, close, volume, timestamp }[]`
- Pass to ORACLE prompt as formatted candle data table
- Keep current snapshot data as well (for real-time reference)

### Token budget
- 17 instruments × (20 daily + 24 hourly) candles ≈ 748 candles
- At ~30 tokens per candle ≈ 22,440 tokens
- May need to reduce to top 5–8 focus instruments for candle data
- Alternative: only fetch candles for `focusInstruments` from analysis-rules.json

### Risks
- Yahoo Finance rate limits on historical data
- Token budget could exceed prompt limits
- Need to balance data volume vs analysis quality

---

## Phase 2 — ICT Pattern Detection

**Goal:** NEXUS can identify real ICT patterns from candle data.

### What to build
- **FVG detection** — scan 3-candle sequences for gaps (candle[0].high < candle[2].low or candle[0].low > candle[2].high)
- **Order Block detection** — find last opposing candle before a displacement move (3+ candle body run in one direction)
- **MSS detection** — identify swing highs/lows and breaks of structure
- **Displacement measurement** — flag candles where body > 70% of range and range > 1.5× average

### Approach options
1. **Prompt-based** — give ORACLE the raw candles and let it identify patterns (simpler, uses AI reasoning)
2. **Code-based** — detect patterns in TypeScript before the prompt, pass pre-identified patterns to ORACLE (more reliable, less token usage)
3. **Hybrid** — code detects candidates, ORACLE confirms and contextualizes

Recommendation: **Hybrid** — code finds FVGs and OBs mechanically, ORACLE decides which are significant in context.

---

## Phase 3 — Multi-Timeframe Confluence

**Goal:** NEXUS can align HTF and LTF patterns for high-probability setups.

### What to build
- HTF (daily) bias determination from structure
- LTF (hourly) entry refinement within HTF bias
- FVG stacking — when an LTF FVG sits inside an HTF FVG
- Order block confluence — LTF entry at HTF order block
- Discount/premium zones — using Fibonacci on HTF swing to identify LTF entry zones

---

## Phase 4 — Trendline Analysis

**Goal:** NEXUS can identify and track trendlines.

### What to build
- Swing high/low detection algorithm from candle data
- Trendline construction by connecting 2+ swing points
- Trendline break detection
- Dynamic trendline tracking across sessions (stored in memory)

---

## Phase 5 — Performance Tracking

**Goal:** NEXUS can evaluate whether its past setups were correct.

### What to build
- After each session, check if previous session's setups:
  - Hit target (success)
  - Hit stoploss (failure)
  - Neither (still active or expired)
- Track win rate, average RR achieved, best/worst instruments
- Feed performance data back to AXIOM for self-evaluation
- AXIOM can adjust rules based on actual results, not just reasoning

---

## Cost Management Strategy

### Current cost (~$11–16/month)
- 3 API calls per session: ORACLE + AXIOM + FORGE (Sonnet for all)
- ~4K output tokens, ~8-10K input tokens per call
- ~$0.10–0.15 per session × 3/day × 22 weekdays

### Projected cost with historical candles (~$33–55/month)
- Input tokens jump significantly with candle data
- ~$0.30–0.50 per session

### Cost reduction strategies (implement as we scale)

1. **Haiku for ORACLE, Sonnet for AXIOM** — market analysis is formulaic pattern matching, reflection needs deeper reasoning. Cuts ORACLE cost by ~80%.

2. **Reduce sessions to 3/day** — Asia open (00:00 UTC), London open (08:00 UTC), NY open (13:00 UTC) are the three that matter most. Cuts cost by 40%.

3. **Conditional FORGE** — only run FORGE API call when AXIOM actually produces code change requests. Currently runs every session regardless.

4. **Cache candle data** — fetch historical candles once per day, reuse across sessions. Only fetch fresh current-session data each run.

5. **Code-based pattern detection (critical for Phase 2)** — detect FVGs, order blocks, MSS in TypeScript before the prompt. Send ORACLE a summary like "3 bullish FVGs found on NAS100 1H at levels X, Y, Z" instead of raw candle data. Massively reduces input tokens — potentially 10x cheaper than sending raw candles.

6. **Revenue model** — if NEXUS proves valuable, even $10/month from a handful of subscribers covers API costs. Potential models:
   - GitHub Sponsors (already set up)
   - Premium tier with alerts/notifications
   - API access for other tools to consume NEXUS signals

### Priority order
Strategy 5 (code-based detection) is the highest priority — it's not just cheaper, it produces better results because the AI reasons about patterns, not raw data. Strategy 1 (Haiku for ORACLE) is the easiest quick win. Strategy 3 (conditional FORGE) is trivial to implement.

---

## Future Ideas (not planned yet)
- Real-time data via WebSocket for intraday sessions
- Economic calendar integration (NFP, CPI, FOMC dates)
- Backtesting framework — run NEXUS against historical data
- Multiple AI models — use different models for ORACLE vs AXIOM
- Alert system — notify when a high-confidence setup is identified
- Dashboard — real-time web UI showing current state and active setups
- Subscription/API tier for traders who want NEXUS signals programmatically
