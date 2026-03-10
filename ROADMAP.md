# NEXUS Roadmap

## Current State (v1 — Sessions 1–17)

NEXUS receives one **price snapshot** per instrument per session: price, previous close, change%, high, low, volume. It runs 5 sessions per day aligned to market opens.

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

## Future Ideas (not planned yet)
- Real-time data via WebSocket for intraday sessions
- Economic calendar integration (NFP, CPI, FOMC dates)
- Backtesting framework — run NEXUS against historical data
- Multiple AI models — use different models for ORACLE vs AXIOM
- Alert system — notify when a high-confidence setup is identified
- Dashboard — real-time web UI showing current state and active setups
