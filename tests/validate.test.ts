import { describe, it, expect, beforeAll } from "vitest";
import { calculateTextSimilarity, validateOracleOutput, validateAxiomOutput, extractConfidenceFromText, resolveConfidence, validateWeekendCryptoScreening, filterNonCompliantSetups, filterR036Setups, detectAxiomRumination, applySetupCountPenalty } from "../src/validate";
import type { OracleAnalysis, JournalEntry } from "../src/types";

// ── calculateTextSimilarity ─────────────────────────────────

describe("calculateTextSimilarity", () => {
  it("returns 1 for identical texts", () => {
    expect(calculateTextSimilarity("hello world", "hello world")).toBe(1);
  });

  it("returns 0 for completely different texts", () => {
    expect(calculateTextSimilarity("alpha beta gamma", "delta epsilon zeta")).toBe(0);
  });

  it("returns 0 when either text is empty", () => {
    expect(calculateTextSimilarity("", "hello")).toBe(0);
    expect(calculateTextSimilarity("hello", "")).toBe(0);
  });

  it("returns 1 when both texts are empty", () => {
    expect(calculateTextSimilarity("", "")).toBe(0);
  });

  it("returns 1 when both texts are only stop words", () => {
    // Both become empty sets after stop word removal
    expect(calculateTextSimilarity("the a an is", "the a an is")).toBe(1);
  });

  it("ignores stop words in similarity calculation", () => {
    const text1 = "the market is bullish";
    const text2 = "a market was bullish";
    // After removing stop words: both become {market, bullish}
    expect(calculateTextSimilarity(text1, text2)).toBe(1);
  });

  it("is case insensitive", () => {
    expect(calculateTextSimilarity("HELLO WORLD", "hello world")).toBe(1);
  });

  it("handles partial overlap correctly", () => {
    const text1 = "market bullish gold";
    const text2 = "market bearish gold";
    // Jaccard: intersection={market, gold}=2, union={market, bullish, gold, bearish}=4 => 0.5
    expect(calculateTextSimilarity(text1, text2)).toBe(0.5);
  });

  it("returns 0 when one text has only stop words and other has real words", () => {
    expect(calculateTextSimilarity("the is a", "hello world")).toBe(0);
  });
});

// ── validateOracleOutput ────────────────────────────────────

describe("validateOracleOutput", () => {
  function makeOracle(overrides: Partial<OracleAnalysis> = {}): OracleAnalysis {
    return {
      timestamp: new Date(),
      sessionId: "test-session",
      marketSnapshots: [],
      analysis: "A".repeat(300), // > 200 chars
      setups: [],
      bias: { overall: "bullish", notes: "Strong uptrend" },
      keyLevels: [],
      confidence: 65,
      ...overrides,
    };
  }

  it("validates a well-formed oracle output", () => {
    const result = validateOracleOutput(makeOracle(), []);
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it("rejects empty analysis text", () => {
    const result = validateOracleOutput(makeOracle({ analysis: "" }), []);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("empty"))).toBe(true);
  });

  it("rejects analysis shorter than 200 chars", () => {
    const result = validateOracleOutput(makeOracle({ analysis: "Too short" }), []);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("too short"))).toBe(true);
  });

  it("rejects non-numeric confidence", () => {
    const result = validateOracleOutput(makeOracle({ confidence: NaN }), []);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("not a valid number"))).toBe(true);
  });

  it("rejects confidence out of 0-100 range", () => {
    const low = validateOracleOutput(makeOracle({ confidence: -5 }), []);
    expect(low.valid).toBe(false);
    expect(low.errors.some((e) => e.includes("out of range"))).toBe(true);

    const high = validateOracleOutput(makeOracle({ confidence: 150 }), []);
    expect(high.valid).toBe(false);
    expect(high.errors.some((e) => e.includes("out of range"))).toBe(true);
  });

  it("accepts confidence at boundaries (0 and 100)", () => {
    expect(validateOracleOutput(makeOracle({ confidence: 0 }), []).valid).toBe(true);
    expect(validateOracleOutput(makeOracle({ confidence: 100 }), []).valid).toBe(true);
  });

  it("rejects invalid bias overall value", () => {
    const result = validateOracleOutput(
      makeOracle({ bias: { overall: "confused" as any, notes: "" } }),
      []
    );
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("Invalid bias"))).toBe(true);
  });

  it("rejects 'mixed' bias with empty notes", () => {
    const result = validateOracleOutput(
      makeOracle({ bias: { overall: "mixed", notes: "" } }),
      []
    );
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("mixed"))).toBe(true);
  });

  it("accepts 'mixed' bias with explanation in notes", () => {
    const result = validateOracleOutput(
      makeOracle({ bias: { overall: "mixed", notes: "Conflicting signals across FX and indices" } }),
      []
    );
    expect(result.valid).toBe(true);
  });

  // ── Setup validation ──

  it("errors on setup with non-positive entry", () => {
    const result = validateOracleOutput(
      makeOracle({
        setups: [{
          instrument: "Gold", type: "FVG", direction: "bullish",
          description: "test", invalidation: "test",
          entry: 0, stop: 1900, target: 2100, RR: 2, timeframe: "1H",
        }],
      }),
      []
    );
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("entry must be a positive"))).toBe(true);
  });

  it("warns on bullish setup where stop >= entry", () => {
    const result = validateOracleOutput(
      makeOracle({
        setups: [{
          instrument: "Gold", type: "FVG", direction: "bullish",
          description: "test", invalidation: "test",
          entry: 2000, stop: 2050, target: 2100, RR: 2, timeframe: "1H",
        }],
      }),
      []
    );
    expect(result.valid).toBe(true); // warnings, not errors
    expect(result.warnings.some((w) => w.includes("bullish but stop"))).toBe(true);
  });

  it("warns on bearish setup where stop <= entry", () => {
    const result = validateOracleOutput(
      makeOracle({
        setups: [{
          instrument: "Gold", type: "FVG", direction: "bearish",
          description: "test", invalidation: "test",
          entry: 2000, stop: 1950, target: 1900, RR: 2, timeframe: "1H",
        }],
      }),
      []
    );
    expect(result.warnings.some((w) => w.includes("bearish but stop"))).toBe(true);
  });

  it("warns on implausibly high R:R (>20) indicating likely decimal error", () => {
    // Reproduces session #143 AUD/USD bug: entry 0.7073, target 1.715 → RR 159.95
    const result = validateOracleOutput(
      makeOracle({
        setups: [{
          instrument: "AUD/USD", type: "MSS", direction: "bullish",
          description: "test", invalidation: "test",
          entry: 0.7073, stop: 0.701, target: 1.715, RR: 159.95, timeframe: "1H",
        }],
      }),
      []
    );
    expect(result.warnings.some((w) => w.includes("implausible") && w.includes("RR"))).toBe(true);
  });

  it("does not warn on a legitimate high R:R up to 20", () => {
    const result = validateOracleOutput(
      makeOracle({
        setups: [{
          instrument: "Gold", type: "FVG", direction: "bullish",
          description: "test", invalidation: "test",
          entry: 2000, stop: 1990, target: 2200, RR: 20, timeframe: "1H",
        }],
      }),
      []
    );
    expect(result.warnings.some((w) => w.includes("implausible") && w.includes("RR"))).toBe(false);
  });

  // ── Tight stop on extreme volatility days ──

  it("warns when stop is <1% from entry during an extreme volatility session (≥3% move)", () => {
    // Reproduces session #145: NASDAQ 20-point stop after +4.78% day, ~0.08% of entry
    const extremeSnapshot = {
      symbol: "NAS100", name: "NASDAQ 100", category: "index",
      price: 25200, previousClose: 24050, change: 1150, changePercent: 4.78,
      high: 25202, low: 24050, timestamp: new Date(),
    };
    const result = validateOracleOutput(
      makeOracle({
        marketSnapshots: [extremeSnapshot],
        setups: [{
          instrument: "NASDAQ 100", type: "PDH", direction: "bullish",
          description: "test", invalidation: "test",
          entry: 25200, stop: 25180, target: 25250, RR: 2.5, timeframe: "4H",
        }],
      }),
      []
    );
    expect(result.warnings.some((w) => w.includes("stop") && w.includes("volatility"))).toBe(true);
  });

  it("does not warn about stop size when session moves are normal (<5%)", () => {
    const normalSnapshot = {
      symbol: "NAS100", name: "NASDAQ 100", category: "index",
      price: 25200, previousClose: 25000, change: 200, changePercent: 0.8,
      high: 25210, low: 24990, timestamp: new Date(),
    };
    const result = validateOracleOutput(
      makeOracle({
        marketSnapshots: [normalSnapshot],
        setups: [{
          instrument: "NASDAQ 100", type: "PDH", direction: "bullish",
          description: "test", invalidation: "test",
          entry: 25200, stop: 25180, target: 25250, RR: 2.5, timeframe: "4H",
        }],
      }),
      []
    );
    expect(result.warnings.some((w) => w.includes("stop") && w.includes("volatility"))).toBe(false);
  });

  it("does not warn when stop is adequately wide (≥1% of entry) even on extreme day", () => {
    const extremeSnapshot = {
      symbol: "NAS100", name: "NASDAQ 100", category: "index",
      price: 25200, previousClose: 24050, change: 1150, changePercent: 4.78,
      high: 25202, low: 24050, timestamp: new Date(),
    };
    const result = validateOracleOutput(
      makeOracle({
        marketSnapshots: [extremeSnapshot],
        setups: [{
          instrument: "NASDAQ 100", type: "PDH", direction: "bullish",
          description: "test", invalidation: "test",
          entry: 25200, stop: 24900, target: 25800, RR: 2, timeframe: "4H",
        }],
      }),
      []
    );
    expect(result.warnings.some((w) => w.includes("stop") && w.includes("volatility"))).toBe(false);
  });

  // ── Recycled analysis detection ──

  it("warns when analysis is >80% similar to previous session", () => {
    const prevEntry: JournalEntry = {
      sessionNumber: 1,
      date: "2024-01-01 10:00",
      title: "Test",
      oracleSummary: "summary",
      axiomSummary: "summary",
      fullAnalysis: makeOracle({ analysis: "The market shows strong bullish momentum with gold rising significantly" }),
      reflection: {
        timestamp: new Date(), sessionId: "prev",
        whatWorked: "", whatFailed: "", cognitiveBiases: [],
        ruleUpdates: [], newSystemPromptSections: "", evolutionSummary: "",
      },
      ruleCount: 10,
      systemPromptVersion: 1,
    };

    // Nearly identical analysis
    const result = validateOracleOutput(
      makeOracle({ analysis: "The market shows strong bullish momentum with gold rising significantly" }),
      [prevEntry]
    );
    expect(result.warnings.some((w) => w.includes("Recycled analysis"))).toBe(true);
  });

  it("does not warn for sufficiently different analyses", () => {
    const prevEntry: JournalEntry = {
      sessionNumber: 1,
      date: "2024-01-01 10:00",
      title: "Test",
      oracleSummary: "summary",
      axiomSummary: "summary",
      fullAnalysis: makeOracle({ analysis: "Markets are bullish driven by gold and equities rally across all sectors" }),
      reflection: {
        timestamp: new Date(), sessionId: "prev",
        whatWorked: "", whatFailed: "", cognitiveBiases: [],
        ruleUpdates: [], newSystemPromptSections: "", evolutionSummary: "",
      },
      ruleCount: 10,
      systemPromptVersion: 1,
    };

    const result = validateOracleOutput(
      makeOracle({ analysis: "Bearish reversal patterns forming in crypto as Bitcoin drops below key support with high volume selling" }),
      [prevEntry]
    );
    expect(result.warnings.some((w) => w.includes("Recycled"))).toBe(false);
  });

  // ── Insufficient setup count (r026 enforcement) ──

  function makeValidSetup(instrument: string) {
    return {
      instrument, type: "FVG" as const, direction: "bullish" as const,
      description: "test", invalidation: "test",
      entry: 1.3, stop: 1.28, target: 1.34, RR: 2, timeframe: "1H",
    };
  }

  it("warns when confidence > 55 and only 1 setup produced (r026)", () => {
    const result = validateOracleOutput(
      makeOracle({ confidence: 72, setups: [makeValidSetup("AUD/USD")] }),
      []
    );
    expect(result.warnings.some((w) => w.includes("r026"))).toBe(true);
  });

  it("warns when confidence > 55 and 2 setups produced (r026)", () => {
    const result = validateOracleOutput(
      makeOracle({ confidence: 60, setups: [makeValidSetup("EUR/USD"), makeValidSetup("GBP/USD")] }),
      []
    );
    expect(result.warnings.some((w) => w.includes("r026"))).toBe(true);
  });

  it("does not warn when confidence > 55 with 3 setups", () => {
    const result = validateOracleOutput(
      makeOracle({ confidence: 72, setups: [makeValidSetup("EUR/USD"), makeValidSetup("GBP/USD"), makeValidSetup("AUD/USD")] }),
      []
    );
    expect(result.warnings.some((w) => w.includes("r026"))).toBe(false);
  });

  it("does not warn when confidence <= 55 with 1 setup", () => {
    const result = validateOracleOutput(
      makeOracle({ confidence: 45, setups: [makeValidSetup("AUD/USD")] }),
      []
    );
    expect(result.warnings.some((w) => w.includes("r026"))).toBe(false);
  });

  it("does not warn when confidence exactly 55 with 1 setup", () => {
    const result = validateOracleOutput(
      makeOracle({ confidence: 55, setups: [makeValidSetup("AUD/USD")] }),
      []
    );
    expect(result.warnings.some((w) => w.includes("r026"))).toBe(false);
  });
});

// ── r034: zero-setup screening documentation check ──────────────

describe("validateOracleOutput r034 zero-setup check", () => {
  function makeZeroSetupOracle(overrides: Partial<OracleAnalysis> = {}): OracleAnalysis {
    return {
      sessionId: "test",
      timestamp: new Date().toISOString(),
      analysis: "Major coordinated rally across all asset classes. USD weakness confirmed across multiple pairs.",
      bias: { overall: "bullish", notes: "Coordinated risk-on" },
      confidence: 50,
      setups: [],
      keyLevels: [],
      marketSnapshots: [],
      assumptions: [],
      ...overrides,
    };
  }

  it("warns when confidence >= 50 with bullish bias and zero setups and no rejection doc", () => {
    const result = validateOracleOutput(makeZeroSetupOracle(), []);
    expect(result.warnings.some((w) => w.includes("r034"))).toBe(true);
  });

  it("warns when confidence >= 50 with mixed bias and zero setups and no rejection doc", () => {
    const result = validateOracleOutput(
      makeZeroSetupOracle({ bias: { overall: "mixed", notes: "divergence" } }),
      []
    );
    expect(result.warnings.some((w) => w.includes("r034"))).toBe(true);
  });

  it("does not warn when analysis documents rejection reasoning (poor RR)", () => {
    const result = validateOracleOutput(
      makeZeroSetupOracle({ analysis: "Evaluated EUR/USD at 1.18 resistance — poor RR at this level given current volatility." }),
      []
    );
    expect(result.warnings.some((w) => w.includes("r034"))).toBe(false);
  });

  it("does not warn when analysis documents rejection reasoning (conflicting timeframe)", () => {
    const result = validateOracleOutput(
      makeZeroSetupOracle({ analysis: "Screened all forex majors — conflicting timeframe signals on 1H vs 4H prevented setup identification." }),
      []
    );
    expect(result.warnings.some((w) => w.includes("r034"))).toBe(false);
  });

  it("does not warn when confidence < 50 with zero setups", () => {
    const result = validateOracleOutput(makeZeroSetupOracle({ confidence: 49 }), []);
    expect(result.warnings.some((w) => w.includes("r034"))).toBe(false);
  });

  it("does not warn when bias is neutral with zero setups", () => {
    const result = validateOracleOutput(
      makeZeroSetupOracle({ confidence: 55, bias: { overall: "neutral", notes: "" } }),
      []
    );
    expect(result.warnings.some((w) => w.includes("r034"))).toBe(false);
  });

  it("does not warn when zero setups but setups exist (sanity)", () => {
    const result = validateOracleOutput(
      makeZeroSetupOracle({ setups: [{ instrument: "EUR/USD", type: "FVG", direction: "bullish", entry: 1.18, stop: 1.17, target: 1.20, RR: 2, timeframe: "1H" }] }),
      []
    );
    expect(result.warnings.some((w) => w.includes("r034"))).toBe(false);
  });

  it("fires when calibrated confidence is 49 but raw text confidence is 69 (session #160 scenario)", () => {
    const result = validateOracleOutput(
      makeZeroSetupOracle({
        confidence: 49,
        analysis: "Confidence: 69% — TC (65%), MA (75%), RR (70%). Major coordinated rally.",
      }),
      []
    );
    expect(result.warnings.some((w) => w.includes("r034"))).toBe(true);
  });
});

// ── r038: high-conviction proportional output check ─────────────

describe("validateOracleOutput r038 high-conviction check", () => {
  function makeHighConfOracle(overrides: Partial<OracleAnalysis> = {}): OracleAnalysis {
    return {
      sessionId: "test",
      timestamp: new Date().toISOString(),
      analysis: "Confidence: 69% — TC (65%), MA (75%), RR (70%). NASDAQ surged. EUR/USD rallied. GBP/USD up. Bitcoin strong.",
      bias: { overall: "bullish", notes: "risk-on" },
      confidence: 49, // calibrated down from 69
      setups: [],
      keyLevels: [],
      marketSnapshots: [
        { symbol: "NQ=F", name: "nasdaq", category: "indices", price: 20000, previousClose: 19000, change: 1000, changePercent: 5.26, high: 20100, low: 19000, timestamp: "" },
        { symbol: "EURUSD=X", name: "eur/usd", category: "forex", price: 1.18, previousClose: 1.17, change: 0.01, changePercent: 0.85, high: 1.18, low: 1.17, timestamp: "" },
        { symbol: "GBPUSD=X", name: "gbp/usd", category: "forex", price: 1.36, previousClose: 1.35, change: 0.01, changePercent: 0.74, high: 1.36, low: 1.35, timestamp: "" },
        { symbol: "BTC-USD", name: "bitcoin", category: "crypto", price: 75000, previousClose: 73000, change: 2000, changePercent: 2.74, high: 75500, low: 73000, timestamp: "" },
      ],
      assumptions: [],
      ...overrides,
    };
  }

  it("warns when raw confidence >= 60 and only 1 setup and fewer than 5 instruments mentioned", () => {
    const result = validateOracleOutput(
      makeHighConfOracle({
        setups: [{ instrument: "EUR/USD", type: "FVG", direction: "bullish", entry: 1.18, stop: 1.17, target: 1.20, RR: 2, timeframe: "1H" }],
      }),
      []
    );
    expect(result.warnings.some((w) => w.includes("r038"))).toBe(true);
  });

  it("does not warn when 2+ setups present", () => {
    const result = validateOracleOutput(
      makeHighConfOracle({
        setups: [
          { instrument: "EUR/USD", type: "FVG", direction: "bullish", entry: 1.18, stop: 1.17, target: 1.20, RR: 2, timeframe: "1H" },
          { instrument: "Bitcoin", type: "MSS", direction: "bullish", entry: 75000, stop: 73000, target: 78000, RR: 1.5, timeframe: "4H" },
        ],
      }),
      []
    );
    expect(result.warnings.some((w) => w.includes("r038"))).toBe(false);
  });

  it("does not warn when bias is neutral", () => {
    const result = validateOracleOutput(
      makeHighConfOracle({ bias: { overall: "neutral", notes: "" } }),
      []
    );
    expect(result.warnings.some((w) => w.includes("r038"))).toBe(false);
  });

  it("does not warn when raw confidence < 60", () => {
    const result = validateOracleOutput(
      makeHighConfOracle({ confidence: 45, analysis: "Confidence: 58% — TC (55%), MA (60%), RR (60%). Some analysis." }),
      []
    );
    expect(result.warnings.some((w) => w.includes("r038"))).toBe(false);
  });
});

// ── r039: coordinated market cross-asset screening check ─────

describe("validateOracleOutput r039 cross-asset screening check", () => {
  const coordinatedSnapshots = [
    { name: "EUR/USD",     symbol: "EURUSD",  price: 1.18,   changePercent: 2.5,  volume: 1000 },
    { name: "GBP/USD",     symbol: "GBPUSD",  price: 1.35,   changePercent: 3.1,  volume: 1000 },
    { name: "NASDAQ 100",  symbol: "NAS100",  price: 19000,  changePercent: 6.6,  volume: 5000 },
    { name: "S&P 500",     symbol: "SPX",     price: 5500,   changePercent: 5.2,  volume: 5000 },
    { name: "Gold",        symbol: "XAUUSD",  price: 4860,   changePercent: 2.1,  volume: 2000 },
    { name: "Bitcoin",     symbol: "BTCUSD",  price: 74695,  changePercent: 2.35, volume: 8000 },
    { name: "Ethereum",    symbol: "ETHUSD",  price: 2336,   changePercent: 4.06, volume: 6000 },
  ];

  function makeR039Oracle(overrides: Partial<OracleAnalysis> = {}): OracleAnalysis {
    return {
      sessionId: "test",
      timestamp: new Date().toISOString(),
      analysis: "Confidence: 58% — TC (60%), MA (55%), RR (60%). Broad USD weakness with indices surging.",
      bias: { overall: "mixed", notes: "coordinated risk-on across 4 asset classes" },
      confidence: 38, // calibrated down from 58
      setups: [
        { instrument: "Bitcoin", type: "MSS", direction: "bullish", entry: 74695, stop: 73500, target: 76500, RR: 1.51, timeframe: "4H" },
        { instrument: "Ethereum", type: "MSS", direction: "bullish", entry: 2336, stop: 2280, target: 2420, RR: 1.5, timeframe: "4H" },
      ],
      marketSnapshots: coordinatedSnapshots,
      keyLevels: [],
      assumptions: ["USD weakness attribution unconfirmed"],
      ...overrides,
    } as OracleAnalysis;
  }

  it("warns when raw confidence >=55, 3+ classes moving >2%, and setups cover only one asset class", () => {
    const result = validateOracleOutput(makeR039Oracle(), []);
    expect(result.warnings.some((w) => w.includes("r039"))).toBe(true);
  });

  it("does not warn when setups span 2+ asset classes", () => {
    const result = validateOracleOutput(
      makeR039Oracle({
        setups: [
          { instrument: "Bitcoin", type: "MSS", direction: "bullish", entry: 74695, stop: 73500, target: 76500, RR: 1.51, timeframe: "4H" },
          { instrument: "EUR/USD", type: "FVG", direction: "bullish", entry: 1.18, stop: 1.17, target: 1.20, RR: 2, timeframe: "1H" },
        ],
      }),
      []
    );
    expect(result.warnings.some((w) => w.includes("r039"))).toBe(false);
  });

  it("does not warn when fewer than 3 asset classes have moves >2%", () => {
    const fewClassSnapshots = [
      { name: "EUR/USD", symbol: "EURUSD", price: 1.18,  changePercent: 2.5,  volume: 1000 },
      { name: "Bitcoin", symbol: "BTCUSD", price: 74695, changePercent: 2.35, volume: 8000 },
      { name: "Gold",    symbol: "XAUUSD", price: 4860,  changePercent: 0.5,  volume: 2000 }, // flat
      { name: "NASDAQ",  symbol: "NAS100", price: 19000, changePercent: 0.8,  volume: 5000 }, // flat
    ];
    const result = validateOracleOutput(
      makeR039Oracle({ marketSnapshots: fewClassSnapshots }),
      []
    );
    expect(result.warnings.some((w) => w.includes("r039"))).toBe(false);
  });

  it("does not warn when effective confidence is below 55", () => {
    const result = validateOracleOutput(
      makeR039Oracle({
        confidence: 38,
        analysis: "Confidence: 53% — TC (50%), MA (55%), RR (55%). Broad USD weakness.",
      }),
      []
    );
    expect(result.warnings.some((w) => w.includes("r039"))).toBe(false);
  });

  it("does not warn when bias is neutral", () => {
    const result = validateOracleOutput(
      makeR039Oracle({ bias: { overall: "neutral", notes: "" } }),
      []
    );
    expect(result.warnings.some((w) => w.includes("r039"))).toBe(false);
  });
});

// ── r040: validation accountability — cross-asset setup diversity ─────────

describe("validateOracleOutput r040 cross-asset validation accountability", () => {
  const coordinatedSnapshots = [
    { name: "EUR/USD",    symbol: "EURUSD",  price: 1.18,   changePercent: 0.94,  volume: 1000 },
    { name: "GBP/USD",    symbol: "GBPUSD",  price: 1.36,   changePercent: 1.20,  volume: 1000 },
    { name: "NASDAQ 100", symbol: "NAS100",  price: 25800,  changePercent: 6.39,  volume: 5000 },
    { name: "S&P 500",    symbol: "SPX",     price: 5700,   changePercent: 5.04,  volume: 5000 },
    { name: "Gold",       symbol: "XAUUSD",  price: 4867,   changePercent: 1.40,  volume: 2000 },
    { name: "Bitcoin",    symbol: "BTCUSD",  price: 75886,  changePercent: 1.52,  volume: 8000 },
    { name: "Polkadot",   symbol: "DOTUSD",  price: 1.15,   changePercent: -11.68, volume: 3000 },
  ];

  function makeR040Oracle(overrides: Partial<OracleAnalysis> = {}): OracleAnalysis {
    return {
      sessionId: "test",
      timestamp: new Date().toISOString(),
      // Session #163 scenario: 61% raw confidence, analysis mentions many instruments but no quantified rejection
      analysis: "Confidence: 61% — TC (65%), MA (55%), RR (60%). Risk assets showing exceptional coordinated rally with NASDAQ +6.39%, S&P 500 +5.04%, EUR/USD +0.94%, GBP/USD +1.20%. Gold +1.40% alongside equity rally. Bitcoin +1.52%, ADA -5.31%, DOT -11.68%.",
      bias: { overall: "mixed", notes: "risk asset rally with USD weakness but oil collapse and crypto divergence" },
      confidence: 45, // calibrated down from 61
      setups: [
        { instrument: "Polkadot", type: "MSS", direction: "bearish", entry: 1.15, stop: 1.23, target: 1.045, RR: 1.31, timeframe: "4H" },
      ],
      marketSnapshots: coordinatedSnapshots,
      keyLevels: [],
      assumptions: ["Inflation data triggered USD weakness - unconfirmed"],
      ...overrides,
    } as OracleAnalysis;
  }

  it("warns when confidence >=60, non-neutral bias, single-asset-class setups, no quantified rejection docs", () => {
    // Session #163 scenario: 1 crypto setup, 61% effective confidence, no rejection language
    const result = validateOracleOutput(makeR040Oracle(), []);
    expect(result.warnings.some((w) => w.includes("r040"))).toBe(true);
  });

  it("does not warn when setups span 2+ different asset classes", () => {
    const result = validateOracleOutput(
      makeR040Oracle({
        setups: [
          { instrument: "Polkadot", type: "MSS", direction: "bearish", entry: 1.15, stop: 1.23, target: 1.045, RR: 1.31, timeframe: "4H" },
          { instrument: "EUR/USD",  type: "FVG", direction: "bullish", entry: 1.18, stop: 1.17, target: 1.20, RR: 2, timeframe: "1H" },
        ],
      }),
      []
    );
    expect(result.warnings.some((w) => w.includes("r040"))).toBe(false);
  });

  it("does not warn when analysis contains quantified rejection reasoning", () => {
    const result = validateOracleOutput(
      makeR040Oracle({
        analysis:
          "Confidence: 61% — TC (65%), MA (55%), RR (60%). EUR/USD at 1.18 rejected — poor RR <1.3 with wide spread. GBP/USD at 1.36 rejected — conflicting timeframe on daily. NASDAQ at 25800 rejected — stop >2% required. Gold at 4867 rejected — insufficient confluence. S&P at 5700 rejected — poor RR <1.3. Only DOT viable.",
      }),
      []
    );
    expect(result.warnings.some((w) => w.includes("r040"))).toBe(false);
  });

  it("does not warn when effective confidence is below 60", () => {
    const result = validateOracleOutput(
      makeR040Oracle({
        confidence: 45,
        analysis: "Confidence: 58% — TC (55%), MA (60%), RR (60%). Some analysis text here.",
      }),
      []
    );
    expect(result.warnings.some((w) => w.includes("r040"))).toBe(false);
  });

  it("does not warn when bias is neutral", () => {
    const result = validateOracleOutput(
      makeR040Oracle({ bias: { overall: "neutral", notes: "" } }),
      []
    );
    expect(result.warnings.some((w) => w.includes("r040"))).toBe(false);
  });

  it("still warns when 2 setups exist but both are in same asset class (crypto)", () => {
    const result = validateOracleOutput(
      makeR040Oracle({
        setups: [
          { instrument: "Polkadot", type: "MSS", direction: "bearish", entry: 1.15, stop: 1.23, target: 1.045, RR: 1.31, timeframe: "4H" },
          { instrument: "Bitcoin",  type: "FVG", direction: "bullish", entry: 75000, stop: 73000, target: 78000, RR: 1.5, timeframe: "4H" },
        ],
      }),
      []
    );
    expect(result.warnings.some((w) => w.includes("r040"))).toBe(true);
  });
});

// ── extractConfidenceFromText ────────────────────────────────

describe("extractConfidenceFromText", () => {
  it("extracts direct 'Confidence: X%' pattern", () => {
    expect(extractConfidenceFromText("Confidence: 73% — some notes")).toBe(73);
  });

  it("extracts TC/MA/RR component pattern and computes weighted average", () => {
    // TC=70, MA=50, RR=60 → (70×0.4)+(50×0.3)+(60×0.3) = 28+15+18 = 61
    expect(extractConfidenceFromText("Breakdown: TC (70%), MA (50%), RR (60%)")).toBe(61);
  });

  it("returns null when no confidence pattern found", () => {
    expect(extractConfidenceFromText("The market is bullish today")).toBeNull();
  });

  it("is case insensitive", () => {
    expect(extractConfidenceFromText("confidence: 55%")).toBe(55);
  });
});

// ── Confidence mismatch validation ──────────────────────────

describe("validateOracleOutput confidence mismatch", () => {
  function makeOracle(overrides: Partial<OracleAnalysis> = {}): OracleAnalysis {
    return {
      timestamp: new Date(),
      sessionId: "test-session",
      marketSnapshots: [],
      analysis: "A".repeat(300),
      setups: [],
      bias: { overall: "bullish", notes: "Strong uptrend" },
      keyLevels: [],
      confidence: 65,
      ...overrides,
    };
  }

  it("does not warn when analysis text confidence matches JSON confidence", () => {
    const analysis = "A".repeat(200) + " Confidence: 73% — TC (80%), MA (60%), RR (70%)";
    const result = validateOracleOutput(makeOracle({ analysis, confidence: 73 }), []);
    expect(result.warnings.some((w) => w.includes("Confidence mismatch"))).toBe(false);
  });

  it("warns when analysis text confidence differs from JSON confidence by >15", () => {
    const analysis = "A".repeat(200) + " Confidence: 73% — TC (80%), MA (60%), RR (70%)";
    const result = validateOracleOutput(makeOracle({ analysis, confidence: 50 }), []);
    expect(result.warnings.some((w) => w.includes("Confidence mismatch"))).toBe(true);
    expect(result.warnings.some((w) => w.includes("73%") && w.includes("50%"))).toBe(true);
  });

  it("does not warn when analysis has no confidence text", () => {
    const analysis = "A".repeat(300) + " The market is bullish with strong momentum";
    const result = validateOracleOutput(makeOracle({ analysis, confidence: 50 }), []);
    expect(result.warnings.some((w) => w.includes("Confidence mismatch"))).toBe(false);
  });
});

// ── validateAxiomOutput ─────────────────────────────────────

describe("validateAxiomOutput", () => {
  function makeAxiom(overrides: Record<string, any> = {}) {
    return {
      whatWorked: "Good analysis structure",
      whatFailed: "Missed some correlations",
      evolutionSummary: "Improved this session",
      cognitiveBiases: ["recency bias"],
      ruleUpdates: [],
      newRules: [],
      ...overrides,
    };
  }

  it("validates a well-formed axiom output", () => {
    const result = validateAxiomOutput(makeAxiom(), 5, []);
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it("rejects missing whatWorked", () => {
    const result = validateAxiomOutput(makeAxiom({ whatWorked: "" }), 5, []);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("whatWorked"))).toBe(true);
  });

  it("rejects missing whatFailed", () => {
    const result = validateAxiomOutput(makeAxiom({ whatFailed: "" }), 5, []);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("whatFailed"))).toBe(true);
  });

  it("rejects missing evolutionSummary", () => {
    const result = validateAxiomOutput(makeAxiom({ evolutionSummary: "" }), 5, []);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("evolutionSummary"))).toBe(true);
  });

  it("rejects non-array cognitiveBiases", () => {
    const result = validateAxiomOutput(makeAxiom({ cognitiveBiases: "not an array" }), 5, []);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("cognitiveBiases must be an array"))).toBe(true);
  });

  it("rejects non-array ruleUpdates when present", () => {
    const result = validateAxiomOutput(makeAxiom({ ruleUpdates: "not an array" }), 5, []);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("ruleUpdates must be an array"))).toBe(true);
  });

  it("rejects non-array newRules when present", () => {
    const result = validateAxiomOutput(makeAxiom({ newRules: "not an array" }), 5, []);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("newRules must be an array"))).toBe(true);
  });

  it("allows undefined ruleUpdates and newRules", () => {
    const result = validateAxiomOutput(
      makeAxiom({ ruleUpdates: undefined, newRules: undefined }),
      5, []
    );
    expect(result.valid).toBe(true);
  });

  it("warns on invalid rule ID format", () => {
    const result = validateAxiomOutput(
      makeAxiom({ ruleUpdates: [{ ruleId: "rule_01", type: "modify", after: "new text" }] }),
      5, []
    );
    expect(result.warnings.some((w) => w.includes("invalid ID format"))).toBe(true);
  });

  it("accepts valid rule ID format r + 3 digits", () => {
    const result = validateAxiomOutput(
      makeAxiom({ ruleUpdates: [{ ruleId: "r014", type: "modify", after: "new text" }] }),
      5, []
    );
    expect(result.warnings.some((w) => w.includes("invalid ID format"))).toBe(false);
  });

  // ── Recycled reflection detection ──

  it("warns when evolutionSummary is >70% similar to previous session", () => {
    const prevEntry: JournalEntry = {
      sessionNumber: 4,
      date: "2024-01-01 10:00",
      title: "Test",
      oracleSummary: "",
      axiomSummary: "",
      fullAnalysis: {
        timestamp: new Date(), sessionId: "prev", marketSnapshots: [],
        analysis: "test", setups: [], bias: { overall: "neutral", notes: "" },
        keyLevels: [], confidence: 50,
      },
      reflection: {
        timestamp: new Date(), sessionId: "prev",
        whatWorked: "", whatFailed: "", cognitiveBiases: [],
        ruleUpdates: [], newSystemPromptSections: "",
        evolutionSummary: "Improved confidence calculation methodology with better breakdown",
      },
      ruleCount: 10,
      systemPromptVersion: 1,
    };

    const result = validateAxiomOutput(
      makeAxiom({ evolutionSummary: "Improved confidence calculation methodology with better breakdown" }),
      5, [prevEntry]
    );
    expect(result.warnings.some((w) => w.includes("Recycled reflection"))).toBe(true);
  });
});

// ── checkBiasRuleMapping ─────────────────────────────────────

describe("validateAxiomOutput bias-to-rule mapping", () => {
  function makeAxiom(overrides: Record<string, any> = {}) {
    return {
      whatWorked: "Good analysis",
      whatFailed: "Missed correlations",
      evolutionSummary: "Improved this session",
      cognitiveBiases: [],
      ruleUpdates: [],
      newRules: [],
      ...overrides,
    };
  }

  it("warns when biases detected but no rule updates or new rules address them", () => {
    const result = validateAxiomOutput(
      makeAxiom({ cognitiveBiases: ["narrative dominance", "anchoring bias"], ruleUpdates: [], newRules: [] }),
      5, []
    );
    expect(result.warnings.some((w) => w.includes("cognitive bias") && w.includes("no rule"))).toBe(true);
  });

  it("does not warn when no biases detected", () => {
    const result = validateAxiomOutput(
      makeAxiom({ cognitiveBiases: [], ruleUpdates: [], newRules: [] }),
      5, []
    );
    expect(result.warnings.some((w) => w.includes("cognitive bias") && w.includes("no rule"))).toBe(false);
  });

  it("does not warn when biases detected and a rule update reason overlaps with a bias", () => {
    const result = validateAxiomOutput(
      makeAxiom({
        cognitiveBiases: ["narrative dominance"],
        ruleUpdates: [{ ruleId: "r011", type: "modify", reason: "Address narrative dominance by requiring alternative explanations", after: "new rule text" }],
        newRules: [],
      }),
      5, []
    );
    expect(result.warnings.some((w) => w.includes("cognitive bias") && w.includes("no rule"))).toBe(false);
  });

  it("warns when biases detected but rule update reason has no overlap with any bias", () => {
    const result = validateAxiomOutput(
      makeAxiom({
        cognitiveBiases: ["narrative dominance", "anchoring bias"],
        ruleUpdates: [{ ruleId: "r029", type: "modify", reason: "Increase volatility buffer from 0.75% to 1.25%", after: "new buffer rule" }],
        newRules: [],
      }),
      5, []
    );
    expect(result.warnings.some((w) => w.includes("cognitive bias") || w.includes("rule update"))).toBe(true);
  });

  it("does not warn when a new rule is added that overlaps with detected bias", () => {
    const result = validateAxiomOutput(
      makeAxiom({
        cognitiveBiases: ["confirmation bias"],
        ruleUpdates: [],
        newRules: [{ id: "r035", description: "Avoid confirmation bias by checking counter-signals before setup entry", category: "bias_prevention", weight: 8 }],
      }),
      5, []
    );
    expect(result.warnings.some((w) => w.includes("cognitive bias") && w.includes("no rule"))).toBe(false);
  });
});


// ── resolveConfidence ────────────────────────────────────────

describe("resolveConfidence", () => {
  it("returns extracted text value when mismatch >10 points", () => {
    // Text says 73%, JSON says 50% — diff is 23, so return text value
    const analysis = "Confidence: 73% — TC (80%), MA (60%), RR (70%)";
    expect(resolveConfidence(analysis, 50)).toBe(73);
  });

  it("returns JSON value when no confidence found in text", () => {
    const analysis = "The market is bullish today with strong momentum";
    expect(resolveConfidence(analysis, 65)).toBe(65);
  });

  it("returns JSON value when mismatch is <=10 points", () => {
    // Text says 65%, JSON says 60% — diff is 5, within threshold
    const analysis = "Confidence: 65%";
    expect(resolveConfidence(analysis, 60)).toBe(60);
  });

  it("returns JSON value when mismatch is exactly 10 points (boundary)", () => {
    // diff == 10, not > 10, so return JSON
    const analysis = "Confidence: 70%";
    expect(resolveConfidence(analysis, 60)).toBe(60);
  });

  it("returns extracted value when mismatch is 11 points (just over boundary)", () => {
    const analysis = "Confidence: 71%";
    expect(resolveConfidence(analysis, 60)).toBe(71);
  });
});

// ── validateWeekendCryptoScreening ───────────────────────────

describe("validateWeekendCryptoScreening", () => {
  const cryptoSnapshots = [
    { symbol: "BTC-USD",  name: "Bitcoin",   category: "crypto", price: 96000, previousClose: 97000, change: -1000, changePercent: -1, high: 97000, low: 95000, timestamp: new Date() },
    { symbol: "ETH-USD",  name: "Ethereum",  category: "crypto", price: 3400,  previousClose: 3450,  change: -50,   changePercent: -1.4, high: 3460, low: 3380, timestamp: new Date() },
    { symbol: "SOL-USD",  name: "Solana",    category: "crypto", price: 200,   previousClose: 205,   change: -5,    changePercent: -2.4, high: 206, low: 198, timestamp: new Date() },
    { symbol: "XRP-USD",  name: "Ripple",    category: "crypto", price: 2.5,   previousClose: 2.6,   change: -0.1,  changePercent: -3.8, high: 2.62, low: 2.48, timestamp: new Date() },
    { symbol: "BNB-USD",  name: "BNB",       category: "crypto", price: 600,   previousClose: 610,   change: -10,   changePercent: -1.6, high: 612, low: 598, timestamp: new Date() },
    { symbol: "ADA-USD",  name: "Cardano",   category: "crypto", price: 0.5,   previousClose: 0.52,  change: -0.02, changePercent: -3.8, high: 0.53, low: 0.49, timestamp: new Date() },
    { symbol: "DOGE-USD", name: "Dogecoin",  category: "crypto", price: 0.18,  previousClose: 0.19,  change: -0.01, changePercent: -5.3, high: 0.19, low: 0.17, timestamp: new Date() },
    { symbol: "AVAX-USD", name: "Avalanche", category: "crypto", price: 25,    previousClose: 26,    change: -1,    changePercent: -3.8, high: 26.5, low: 24.5, timestamp: new Date() },
    { symbol: "DOT-USD",  name: "Polkadot",  category: "crypto", price: 7,     previousClose: 7.2,   change: -0.2,  changePercent: -2.8, high: 7.3, low: 6.9, timestamp: new Date() },
    { symbol: "LINK-USD", name: "Chainlink", category: "crypto", price: 15,    previousClose: 15.5,  change: -0.5,  changePercent: -3.2, high: 15.6, low: 14.8, timestamp: new Date() },
  ];

  function makeOracle(overrides: Partial<import("../src/types").OracleAnalysis> = {}): import("../src/types").OracleAnalysis {
    return {
      timestamp: new Date(), sessionId: "test", marketSnapshots: [],
      analysis: "Bitcoin and Ethereum showing bearish momentum this weekend session.",
      setups: [], bias: { overall: "bearish", notes: "Crypto weakness" },
      keyLevels: [], confidence: 45,
      ...overrides,
    };
  }

  it("marks instrument as mentionedOnly when name appears only in analysis text", () => {
    const oracle = makeOracle({ analysis: "Bitcoin shows bearish structure. Ethereum testing support. Solana weak." });
    const { covered, mentionedOnly, missing } = validateWeekendCryptoScreening(oracle, cryptoSnapshots);
    // Text-only mentions go to mentionedOnly, not covered (no setup or key level produced)
    expect(mentionedOnly).toContain("Bitcoin");
    expect(mentionedOnly).toContain("Ethereum");
    expect(mentionedOnly).toContain("Solana");
    expect(covered).not.toContain("Bitcoin");
    expect(missing).not.toContain("Bitcoin");
  });

  it("marks instrument as covered when it appears in setups array", () => {
    const oracle = makeOracle({
      analysis: "Bitcoin bearish.",
      setups: [{
        instrument: "XRP", type: "MSS", direction: "bearish",
        description: "test", invalidation: "test",
        entry: 2.5, stop: 2.65, target: 2.3, RR: 1.33, timeframe: "1H",
      }],
    });
    const { covered, mentionedOnly } = validateWeekendCryptoScreening(oracle, cryptoSnapshots);
    expect(covered).toContain("Ripple");       // XRP → matched via symbol (has setup)
    expect(mentionedOnly).toContain("Bitcoin"); // in analysis text only — no setup or key level
  });

  it("marks instrument as missing when not mentioned anywhere", () => {
    // Analysis only mentions BTC and ETH, no key levels for others
    const oracle = makeOracle({ analysis: "Bitcoin and Ethereum are the only coins discussed here." });
    const { missing } = validateWeekendCryptoScreening(oracle, cryptoSnapshots);
    expect(missing).toContain("Solana");
    expect(missing).toContain("BNB");
    expect(missing).toContain("Avalanche");
    expect(missing).toContain("Polkadot");
    expect(missing).toContain("Chainlink");
  });

  it("marks instrument as covered when it appears only in key levels", () => {
    // ORACLE evaluated DOT and put it in key levels — that counts as covered
    const oracle = makeOracle({
      analysis: "Bitcoin showing weakness.",
      keyLevels: [{ instrument: "Polkadot", level: 7.0, type: "support", notes: "Key support" } as any],
    });
    const { covered, missing } = validateWeekendCryptoScreening(oracle, cryptoSnapshots);
    expect(covered).toContain("Polkadot");
    expect(missing).not.toContain("Polkadot");
  });

  it("all 10 instruments covered when all appear in key levels", () => {
    const keyLevels = cryptoSnapshots.map(s => ({
      instrument: s.name, level: s.price, type: "support", notes: "test",
    }));
    const oracle = makeOracle({ analysis: "Market analysis.", keyLevels: keyLevels as any });
    const { missing } = validateWeekendCryptoScreening(oracle, cryptoSnapshots);
    expect(missing).toHaveLength(0);
  });

  it("returns empty missing when all instruments are covered", () => {
    const analysis = "Bitcoin Ethereum Solana Ripple BNB Cardano Dogecoin Avalanche Polkadot Chainlink all analyzed.";
    const { missing } = validateWeekendCryptoScreening(makeOracle({ analysis }), cryptoSnapshots);
    expect(missing).toHaveLength(0);
  });

  it("handles symbol matching — BTC setup covers Bitcoin snapshot", () => {
    const oracle = makeOracle({
      analysis: "Market analysis.",
      setups: [{
        instrument: "BTC/USD", type: "OB", direction: "bearish",
        description: "test", invalidation: "test",
        entry: 96000, stop: 98000, target: 93000, RR: 1.5, timeframe: "4H",
      }],
    });
    const { covered } = validateWeekendCryptoScreening(oracle, cryptoSnapshots);
    expect(covered).toContain("Bitcoin");
  });

  it("handles USDT-suffixed setup instruments", () => {
    const oracle = makeOracle({
      analysis: "Market analysis.",
      setups: [{
        instrument: "ETHUSDT", type: "MSS", direction: "bearish",
        description: "test", invalidation: "test",
        entry: 3400, stop: 3500, target: 3200, RR: 2, timeframe: "4H",
      }],
    });
    const { covered } = validateWeekendCryptoScreening(oracle, cryptoSnapshots);
    expect(covered).toContain("Ethereum");
  });

  it("returns covered, mentionedOnly, and missing arrays that together equal total snapshots", () => {
    const oracle = makeOracle({ analysis: "Bitcoin showing weakness." });
    const { covered, mentionedOnly, missing } = validateWeekendCryptoScreening(oracle, cryptoSnapshots);
    expect(covered.length + mentionedOnly.length + missing.length).toBe(cryptoSnapshots.length);
  });
});

// ── filterNonCompliantSetups ─────────────────────────────────

describe("filterNonCompliantSetups", () => {
  function makeSnap(changePercent: number) {
    return {
      symbol: "NAS100", name: "NASDAQ 100", category: "indices" as const,
      price: 25000, previousClose: 25000 / (1 + changePercent / 100),
      change: 25000 * changePercent / 100, changePercent,
      high: 25100, low: 24900, timestamp: new Date(),
    };
  }

  function makeSetup(instrument: string, entry: number, stop: number, direction: "bullish" | "bearish" = "bullish") {
    return {
      instrument, type: "MSS" as const, direction,
      description: "test", invalidation: "test",
      entry, stop,
      target: direction === "bullish" ? entry * 1.05 : entry * 0.95,
      RR: 2, timeframe: "4H",
    };
  }

  function makeOracle(snaps: ReturnType<typeof makeSnap>[], setups: ReturnType<typeof makeSetup>[]): OracleAnalysis {
    return {
      timestamp: new Date(), sessionId: "test", marketSnapshots: snaps,
      analysis: "A".repeat(300), setups: setups as any,
      bias: { overall: "mixed", notes: "volatile" }, keyLevels: [], confidence: 45,
    };
  }

  it("removes setup with stop < 1.5% during extreme volatility (≥5% session move)", () => {
    const oracle = makeOracle([makeSnap(5.5)], [makeSetup("NASDAQ 100", 25000, 24900)]); // 0.4% stop
    const { oracle: filtered, removed } = filterNonCompliantSetups(oracle);
    expect(filtered.setups).toHaveLength(0);
    expect(removed).toHaveLength(1);
    expect(removed[0].instrument).toBe("NASDAQ 100");
  });

  it("keeps setup with stop ≥ 1.5% during extreme volatility", () => {
    const oracle = makeOracle([makeSnap(5.5)], [makeSetup("EUR/USD", 1.0, 0.984)]); // 1.6% stop — clearly compliant
    const { oracle: filtered, removed } = filterNonCompliantSetups(oracle);
    expect(filtered.setups).toHaveLength(1);
    expect(removed).toHaveLength(0);
  });

  it("removes setup with stop < 1.0% during moderate volatility (3–4.9% session move)", () => {
    const oracle = makeOracle([makeSnap(3.5)], [makeSetup("GBP/USD", 1.34, 1.333)]); // ~0.52% stop
    const { oracle: filtered, removed } = filterNonCompliantSetups(oracle);
    expect(filtered.setups).toHaveLength(0);
    expect(removed).toHaveLength(1);
  });

  it("keeps setup with stop ≥ 1.0% during moderate volatility", () => {
    const oracle = makeOracle([makeSnap(3.5)], [makeSetup("GBP/USD", 1.34, 1.3265)]); // ~1.0% stop
    const { oracle: filtered, removed } = filterNonCompliantSetups(oracle);
    expect(filtered.setups).toHaveLength(1);
    expect(removed).toHaveLength(0);
  });

  it("keeps all setups during normal volatility (< 3% moves)", () => {
    const oracle = makeOracle([makeSnap(1.5)], [makeSetup("EUR/USD", 1.17, 1.169)]); // 0.09% — would fail in extreme
    const { oracle: filtered, removed } = filterNonCompliantSetups(oracle);
    expect(filtered.setups).toHaveLength(1);
    expect(removed).toHaveLength(0);
  });

  it("keeps compliant and removes non-compliant in mixed setup list during extreme day", () => {
    const oracle = makeOracle(
      [makeSnap(5.2)],
      [
        makeSetup("NASDAQ 100", 25000, 24600), // 1.6% stop — compliant
        makeSetup("EUR/USD", 1.17, 1.168),      // 0.17% stop — non-compliant
      ]
    );
    const { oracle: filtered, removed } = filterNonCompliantSetups(oracle);
    expect(filtered.setups).toHaveLength(1);
    expect((filtered.setups as any)[0].instrument).toBe("NASDAQ 100");
    expect(removed[0].instrument).toBe("EUR/USD");
  });

  it("returns empty removed array when no setups present", () => {
    const { removed } = filterNonCompliantSetups(
      makeOracle([makeSnap(6.0)], [])
    );
    expect(removed).toHaveLength(0);
  });

  it("returns empty removed array when no snapshots present", () => {
    const { removed } = filterNonCompliantSetups(
      makeOracle([], [makeSetup("EUR/USD", 1.17, 1.169)])
    );
    expect(removed).toHaveLength(0);
  });

  it("does not mutate the original oracle object", () => {
    const oracle = makeOracle([makeSnap(5.5)], [makeSetup("NASDAQ 100", 25000, 24900)]);
    filterNonCompliantSetups(oracle);
    expect(oracle.setups).toHaveLength(1); // original unchanged
  });

  it("uses absolute changePercent so negative moves also trigger filter", () => {
    const oracle = makeOracle([makeSnap(-5.5)], [makeSetup("NASDAQ 100", 25000, 24900, "bearish")]); // bearish: stop above entry
    // Bearish: stop 25100 vs entry 25000 = 0.4% — should be removed
    const bearishOracle = makeOracle([makeSnap(-5.5)], [{
      ...makeSetup("NASDAQ 100", 25000, 25100, "bearish"),
      target: 24000,
    } as any]);
    const { removed } = filterNonCompliantSetups(bearishOracle);
    expect(removed).toHaveLength(1);
  });
});

// ── filterR036Setups ─────────────────────────────────────────

describe("filterR036Setups", () => {
  function makeSnap(name: string, symbol: string, changePercent: number) {
    return {
      symbol, name, category: "forex" as const,
      price: 1.1, previousClose: 1.1 / (1 + changePercent / 100),
      change: 1.1 * changePercent / 100, changePercent,
      high: 1.11, low: 1.09, timestamp: new Date(),
    };
  }

  function makeSetup(instrument: string, direction: "bullish" | "bearish", entry = 25000) {
    const isBearish = direction === "bearish";
    return {
      instrument, type: "MSS" as const, direction,
      description: "test", invalidation: "test",
      entry,
      stop: isBearish ? entry * 1.02 : entry * 0.98,
      target: isBearish ? entry * 0.96 : entry * 1.04,
      RR: 2, timeframe: "4H",
    };
  }

  function makeOracle(snaps: any[], setups: any[]): OracleAnalysis {
    return {
      timestamp: new Date(), sessionId: "test", marketSnapshots: snaps,
      analysis: "A".repeat(300), setups,
      bias: { overall: "bullish", notes: "USD weakness" }, keyLevels: [], confidence: 55,
    };
  }

  const eurUp   = makeSnap("EUR/USD", "EURUSD", 1.25);
  const gbpUp   = makeSnap("GBP/USD", "GBPUSD", 1.34);
  const eurFlat = makeSnap("EUR/USD", "EURUSD", 0.5);
  const gbpFlat = makeSnap("GBP/USD", "GBPUSD", 0.3);

  it("removes bearish index setup when EUR/USD and GBP/USD both >+1%", () => {
    const oracle = makeOracle([eurUp, gbpUp], [makeSetup("NASDAQ 100", "bearish")]);
    const { oracle: filtered, removed } = filterR036Setups(oracle);
    expect(filtered.setups).toHaveLength(0);
    expect(removed).toHaveLength(1);
    expect(removed[0].instrument).toBe("NASDAQ 100");
    expect(removed[0].reason).toMatch(/r036/);
  });

  it("removes bearish crypto setup when EUR/USD and GBP/USD both >+1%", () => {
    const oracle = makeOracle([eurUp, gbpUp], [makeSetup("Bitcoin", "bearish", 80000)]);
    const { oracle: filtered, removed } = filterR036Setups(oracle);
    expect(filtered.setups).toHaveLength(0);
    expect(removed).toHaveLength(1);
    expect(removed[0].instrument).toBe("Bitcoin");
  });

  it("keeps bullish index/crypto setups even when EUR/USD and GBP/USD both >+1%", () => {
    const oracle = makeOracle([eurUp, gbpUp], [makeSetup("NASDAQ 100", "bullish")]);
    const { oracle: filtered, removed } = filterR036Setups(oracle);
    expect(filtered.setups).toHaveLength(1);
    expect(removed).toHaveLength(0);
  });

  it("keeps bearish forex setups — r036 only blocks risk assets", () => {
    const oracle = makeOracle([eurUp, gbpUp], [makeSetup("USD/JPY", "bearish", 150)]);
    const { oracle: filtered, removed } = filterR036Setups(oracle);
    expect(filtered.setups).toHaveLength(1);
    expect(removed).toHaveLength(0);
  });

  it("keeps bearish commodity setups — r036 only blocks risk assets", () => {
    const oracle = makeOracle([eurUp, gbpUp], [makeSetup("Gold", "bearish", 3000)]);
    const { oracle: filtered, removed } = filterR036Setups(oracle);
    expect(filtered.setups).toHaveLength(1);
    expect(removed).toHaveLength(0);
  });

  it("does not filter when only EUR/USD is >+1% (GBP flat)", () => {
    const oracle = makeOracle([eurUp, gbpFlat], [makeSetup("NASDAQ 100", "bearish")]);
    const { oracle: filtered, removed } = filterR036Setups(oracle);
    expect(filtered.setups).toHaveLength(1);
    expect(removed).toHaveLength(0);
  });

  it("does not filter when only GBP/USD is >+1% (EUR flat)", () => {
    const oracle = makeOracle([eurFlat, gbpUp], [makeSetup("NASDAQ 100", "bearish")]);
    const { oracle: filtered, removed } = filterR036Setups(oracle);
    expect(filtered.setups).toHaveLength(1);
    expect(removed).toHaveLength(0);
  });

  it("does not filter when neither EUR/USD nor GBP/USD is >+1%", () => {
    const oracle = makeOracle([eurFlat, gbpFlat], [makeSetup("NASDAQ 100", "bearish")]);
    const { oracle: filtered, removed } = filterR036Setups(oracle);
    expect(filtered.setups).toHaveLength(1);
    expect(removed).toHaveLength(0);
  });

  it("removes only violating setups in a mixed list", () => {
    const oracle = makeOracle(
      [eurUp, gbpUp],
      [
        makeSetup("NASDAQ 100", "bearish"),   // violates r036
        makeSetup("EUR/USD", "bullish", 1.1), // OK — bullish
        makeSetup("Bitcoin", "bearish", 80000), // violates r036
      ]
    );
    const { oracle: filtered, removed } = filterR036Setups(oracle);
    expect(filtered.setups).toHaveLength(1);
    expect((filtered.setups as any)[0].instrument).toBe("EUR/USD");
    expect(removed).toHaveLength(2);
  });

  it("does not mutate the original oracle object", () => {
    const oracle = makeOracle([eurUp, gbpUp], [makeSetup("NASDAQ 100", "bearish")]);
    filterR036Setups(oracle);
    expect(oracle.setups).toHaveLength(1); // original unchanged
  });

  it("returns empty removed array when no setups present", () => {
    const { removed } = filterR036Setups(makeOracle([eurUp, gbpUp], []));
    expect(removed).toHaveLength(0);
  });

  it("returns empty removed array when no market snapshots present", () => {
    const { removed } = filterR036Setups(makeOracle([], [makeSetup("NASDAQ 100", "bearish")]));
    expect(removed).toHaveLength(0);
  });
});

// ── detectAxiomRumination ────────────────────────────────────

describe("detectAxiomRumination", () => {
  it("returns warning when whatFailed mentions compliance violation with no actions taken", () => {
    const parsed = {
      whatFailed: "Critical compliance failure on r029 — stop distances violated minimum requirements",
      ruleUpdates: [], newRules: [], newSelfTasks: [],
    };
    const warning = detectAxiomRumination(parsed);
    expect(warning).not.toBeNull();
  });

  it("returns warning when 'execution gap' language is present with no actions", () => {
    const parsed = {
      whatFailed: "This represents a systematic execution gap in stop distance compliance",
      ruleUpdates: [], newRules: [], newSelfTasks: [],
    };
    expect(detectAxiomRumination(parsed)).not.toBeNull();
  });

  it("returns null when a rule update is present alongside violation text", () => {
    const parsed = {
      whatFailed: "Compliance failure on r029",
      ruleUpdates: [{ ruleId: "r029", type: "modify", after: "new text", reason: "fix stops" }],
      newRules: [], newSelfTasks: [],
    };
    expect(detectAxiomRumination(parsed)).toBeNull();
  });

  it("returns null when a new rule is present", () => {
    const parsed = {
      whatFailed: "Compliance violation on stop distances",
      ruleUpdates: [],
      newRules: [{ id: "r038", description: "enforce stops", category: "risk", weight: 9 }],
      newSelfTasks: [],
    };
    expect(detectAxiomRumination(parsed)).toBeNull();
  });

  it("returns null when a self-task is present", () => {
    const parsed = {
      whatFailed: "Compliance violation on stop distances",
      ruleUpdates: [], newRules: [],
      newSelfTasks: [{ title: "Fix stop enforcement", body: "...", category: "rule-gap", priority: "high" }],
    };
    expect(detectAxiomRumination(parsed)).toBeNull();
  });

  it("returns null when whatFailed has no violation language", () => {
    const parsed = {
      whatFailed: "Analysis could use more cross-asset context in future sessions",
      ruleUpdates: [], newRules: [], newSelfTasks: [],
    };
    expect(detectAxiomRumination(parsed)).toBeNull();
  });

  it("returns null when whatFailed is empty", () => {
    const parsed = { whatFailed: "", ruleUpdates: [], newRules: [], newSelfTasks: [] };
    expect(detectAxiomRumination(parsed)).toBeNull();
  });
});

// ── validateAxiomOutput rumination integration ───────────────

describe("validateAxiomOutput rumination detection", () => {
  function makeAxiom(overrides: Record<string, any> = {}) {
    return {
      whatWorked: "Good analysis structure",
      whatFailed: "Missed some correlations",
      evolutionSummary: "Improved this session",
      cognitiveBiases: [],
      ruleUpdates: [], newRules: [], newSelfTasks: [],
      ...overrides,
    };
  }

  it("warns when axiom acknowledges compliance failure without any action", () => {
    const result = validateAxiomOutput(
      makeAxiom({
        whatFailed: "Critical compliance failure on r029 stop distances violated minimum requirements",
        ruleUpdates: [], newRules: [], newSelfTasks: [],
      }),
      5, []
    );
    expect(result.warnings.some((w) => w.includes("acknowledged failure without action"))).toBe(true);
  });

  it("does not warn when rule update accompanies the failure text", () => {
    const result = validateAxiomOutput(
      makeAxiom({
        whatFailed: "Compliance failure on r029",
        ruleUpdates: [{ ruleId: "r029", type: "modify", after: "fixed", reason: "stop enforcement" }],
      }),
      5, []
    );
    expect(result.warnings.some((w) => w.includes("acknowledged failure without action"))).toBe(false);
  });
});

// ── detectAxiomRumination — "failed to execute" keyword ──────

describe("detectAxiomRumination — failed to execute keyword", () => {
  it("triggers when whatFailed contains 'failed to execute'", () => {
    const result = detectAxiomRumination({
      whatFailed: "I failed to execute comprehensive screening despite having the analytical framework for it.",
      ruleUpdates: [], newRules: [], newSelfTasks: [],
    });
    expect(result).not.toBeNull();
    expect(result).toContain("acknowledged failure without action");
  });

  it("does not trigger 'failed to execute' when a rule update accompanies it", () => {
    const result = detectAxiomRumination({
      whatFailed: "I failed to execute systematic screening per r034.",
      ruleUpdates: [{ ruleId: "r034", type: "modify", before: "old", after: "new", reason: "enforce" }],
      newRules: [], newSelfTasks: [],
    });
    expect(result).toBeNull();
  });
});

// ── detectAxiomRumination — "enforcement mechanisms" keywords ──

describe("detectAxiomRumination — enforcement mechanism language", () => {
  it("triggers when whatFailed says enforcement mechanisms are inadequate with no action", () => {
    const result = detectAxiomRumination({
      whatFailed: "enforcement mechanisms are inadequate for systematic screening compliance.",
      ruleUpdates: [], newRules: [], newSelfTasks: [],
    });
    expect(result).not.toBeNull();
  });

  it("triggers when whatFailed says need validation logic with no action", () => {
    const result = detectAxiomRumination({
      whatFailed: "I need validation logic that blocks session completion when requirements are not met.",
      ruleUpdates: [], newRules: [], newSelfTasks: [],
    });
    expect(result).not.toBeNull();
  });

  it("does not trigger when a rule update accompanies enforcement complaint", () => {
    const result = detectAxiomRumination({
      whatFailed: "enforcement mechanisms are inadequate",
      ruleUpdates: [{ ruleId: "r030", type: "modify", before: "old", after: "new", reason: "fix" }],
      newRules: [], newSelfTasks: [],
    });
    expect(result).toBeNull();
  });

  // ── Extended gap-acknowledgment patterns (backlog #6) ──────

  it("detects 'remains a known gap' without action (session #167 pattern)", () => {
    const result = detectAxiomRumination({
      whatFailed: "The screening accountability remains a known gap requiring enforcement rather than additional rules.",
      ruleUpdates: [], newRules: [], newSelfTasks: [],
    });
    expect(result).not.toBeNull();
  });

  it("detects 'requires enforcement' without action", () => {
    const result = detectAxiomRumination({
      whatFailed: "This gap requires enforcement at the code level rather than more rules.",
      ruleUpdates: [], newRules: [], newSelfTasks: [],
    });
    expect(result).not.toBeNull();
  });

  it("detects 'known gap' phrase without action", () => {
    const result = detectAxiomRumination({
      whatFailed: "This is a known gap that has persisted across multiple sessions.",
      ruleUpdates: [], newRules: [], newSelfTasks: [],
    });
    expect(result).not.toBeNull();
  });

  it("does not flag 'known gap' when a self-task is created", () => {
    const result = detectAxiomRumination({
      whatFailed: "The screening gap remains a known gap requiring enforcement.",
      ruleUpdates: [], newRules: [],
      newSelfTasks: [{ title: "Fix screening enforcement", category: "rule-gap", priority: "high" }],
    });
    expect(result).toBeNull();
  });
});

// ── applySetupCountPenalty (backlog #13) ─────────────────────

describe("applySetupCountPenalty", () => {
  it("returns unchanged confidence when setups meet the threshold for 51-70% confidence", () => {
    // 67% confidence: threshold is 3 (>50 but <=70), has 3 setups → no penalty
    const result = applySetupCountPenalty(67, 3, false);
    expect(result.penalized).toBe(67);
    expect(result.reason).toBeNull();
  });

  it("does NOT hard-cap to 45% — regression for sessions #166 and #167", () => {
    // Under old code: 67% confidence, 3 setups → Math.min(67, 45) = 45. Must NOT happen.
    const result = applySetupCountPenalty(67, 3, false);
    expect(result.penalized).not.toBe(45);
  });

  it("returns unchanged confidence when confidence is 50 or below", () => {
    const result = applySetupCountPenalty(45, 0, false);
    expect(result.penalized).toBe(45);
    expect(result.reason).toBeNull();
  });

  it("applies proportional penalty for 1 missing setup at >70% confidence", () => {
    // 75% confidence needs 4 setups, has 3 → shortfall 1 → 75 - 10 = 65
    const result = applySetupCountPenalty(75, 3, false);
    expect(result.penalized).toBe(65);
    expect(result.reason).not.toBeNull();
  });

  it("applies proportional penalty for 2 missing setups at >70% confidence", () => {
    // 75% needs 4, has 2 → shortfall 2 → 75 - 20 = 55
    const result = applySetupCountPenalty(75, 2, false);
    expect(result.penalized).toBe(55);
  });

  it("does not reduce below 35%", () => {
    // 75% needs 4, has 0 → shortfall 4 → Math.max(35, 75-40) = 35
    const result = applySetupCountPenalty(75, 0, false);
    expect(result.penalized).toBe(35);
  });

  it("weekend sessions require minimum 2 setups", () => {
    // Weekend, 65% confidence, 1 setup → shortfall 1 → 65 - 10 = 55
    const result = applySetupCountPenalty(65, 1, true);
    expect(result.penalized).toBe(55);
    expect(result.reason).not.toBeNull();
  });

  it("weekend sessions with 2 setups have no penalty", () => {
    const result = applySetupCountPenalty(65, 2, true);
    expect(result.penalized).toBe(65);
    expect(result.reason).toBeNull();
  });

  it("weekend sessions with 0 required setups below threshold have no penalty", () => {
    const result = applySetupCountPenalty(45, 0, true);
    // Weekend min is always 2, so 0 setups at 45% → shortfall 2 → 45-20=25 → floor 35
    // Actually weekend always requires 2, so this should penalize
    expect(result.penalized).toBe(35);
  });
});

// ── r031: confidence cap enforcement ─────────────────────────

describe("validateOracleOutput r031 cap enforcement", () => {
  function makeOracle31(confidence: number, analysis: string): OracleAnalysis {
    return {
      sessionId: "test", timestamp: new Date(),
      analysis: analysis.padEnd(300, " "),
      bias: { overall: "bullish", notes: "risk-on" },
      confidence, setups: [], keyLevels: [], marketSnapshots: [], assumptions: [],
    };
  }

  it("warns when confidence exceeds 65 with no cap notation", () => {
    const result = validateOracleOutput(
      makeOracle31(67, "Confidence: 67% — TC (70%), MA (65%), RR (60%). Strong bullish move."),
      []
    );
    expect(result.warnings.some((w) => w.includes("r031"))).toBe(true);
  });

  it("does not warn when confidence is exactly 65", () => {
    const result = validateOracleOutput(
      makeOracle31(65, "Confidence: 65% — TC (65%), MA (65%), RR (65%). Analysis here."),
      []
    );
    expect(result.warnings.some((w) => w.includes("r031"))).toBe(false);
  });

  it("does not warn when analysis contains cap notation", () => {
    const result = validateOracleOutput(
      makeOracle31(67, "Confidence: 70% — TC (70%), MA (70%), RR (70%). capped from 72% due to calibration discipline."),
      []
    );
    expect(result.warnings.some((w) => w.includes("r031"))).toBe(false);
  });

  it("does not warn when raw text confidence is also <= 65 (JSON field mismatch harmless)", () => {
    const result = validateOracleOutput(
      makeOracle31(45, "Confidence: 58% — TC (55%), MA (60%), RR (60%). Analysis."),
      []
    );
    expect(result.warnings.some((w) => w.includes("r031"))).toBe(false);
  });
});

// ── r036: bearish risk asset during DXY weakness ─────────────

describe("validateOracleOutput r036 DXY weakness check", () => {
  function makeSnap(name: string, symbol: string, cat: string, changePercent: number) {
    return { symbol, name, category: cat, price: 1.18, previousClose: 1.17, change: 0.01, changePercent, high: 1.19, low: 1.17, timestamp: new Date() };
  }

  const dxyWeaknessSnaps = [
    makeSnap("EUR/USD", "EURUSD=X", "forex", 1.06),
    makeSnap("GBP/USD", "GBPUSD=X", "forex", 1.20),
    makeSnap("NASDAQ 100", "NQ=F", "indices", 5.3),
  ];

  function makeSetup(instrument: string, direction: "bullish" | "bearish") {
    return {
      instrument, type: "MSS" as const, direction, description: "test", invalidation: "test",
      entry: direction === "bearish" ? 25000 : 1.18,
      stop:  direction === "bearish" ? 25500 : 1.17,
      target: direction === "bearish" ? 24000 : 1.20,
      RR: 2, timeframe: "4H",
    };
  }

  it("warns on bearish index setup during active DXY weakness (EUR + GBP both >1%)", () => {
    const oracle: OracleAnalysis = {
      sessionId: "test", timestamp: new Date(),
      analysis: "USD weakness confirmed. NASDAQ extended at highs.".padEnd(300, " "),
      bias: { overall: "mixed", notes: "conflicting" }, confidence: 58,
      setups: [makeSetup("NASDAQ 100", "bearish")],
      keyLevels: [], marketSnapshots: dxyWeaknessSnaps, assumptions: [],
    };
    expect(validateOracleOutput(oracle, []).warnings.some((w) => w.includes("r036"))).toBe(true);
  });

  it("warns on bearish crypto setup during active DXY weakness", () => {
    const oracle: OracleAnalysis = {
      sessionId: "test", timestamp: new Date(),
      analysis: "DXY weakness. Bitcoin extended.".padEnd(300, " "),
      bias: { overall: "mixed", notes: "conflicting" }, confidence: 58,
      setups: [makeSetup("Bitcoin", "bearish")],
      keyLevels: [], marketSnapshots: dxyWeaknessSnaps, assumptions: [],
    };
    expect(validateOracleOutput(oracle, []).warnings.some((w) => w.includes("r036"))).toBe(true);
  });

  it("does not warn on bullish risk asset setup during DXY weakness", () => {
    const oracle: OracleAnalysis = {
      sessionId: "test", timestamp: new Date(),
      analysis: "DXY weakness confirmed, risk-on bias.".padEnd(300, " "),
      bias: { overall: "bullish", notes: "risk-on" }, confidence: 58,
      setups: [makeSetup("NASDAQ 100", "bullish")],
      keyLevels: [], marketSnapshots: dxyWeaknessSnaps, assumptions: [],
    };
    expect(validateOracleOutput(oracle, []).warnings.some((w) => w.includes("r036"))).toBe(false);
  });

  it("does not warn when only EUR/USD is up >1% but GBP/USD is not", () => {
    const partialSnaps = [
      makeSnap("EUR/USD", "EURUSD=X", "forex", 1.10),
      makeSnap("GBP/USD", "GBPUSD=X", "forex", 0.80),
      makeSnap("NASDAQ 100", "NQ=F", "indices", 5.3),
    ];
    const oracle: OracleAnalysis = {
      sessionId: "test", timestamp: new Date(),
      analysis: "Mixed signals.".padEnd(300, " "),
      bias: { overall: "mixed", notes: "conflicting" }, confidence: 58,
      setups: [makeSetup("NASDAQ 100", "bearish")],
      keyLevels: [], marketSnapshots: partialSnaps, assumptions: [],
    };
    expect(validateOracleOutput(oracle, []).warnings.some((w) => w.includes("r036"))).toBe(false);
  });

  it("does not warn on bearish forex setup during DXY weakness (forex is not a risk asset)", () => {
    const oracle: OracleAnalysis = {
      sessionId: "test", timestamp: new Date(),
      analysis: "USD/CHF bearish on DXY weakness.".padEnd(300, " "),
      bias: { overall: "mixed", notes: "conflicting" }, confidence: 58,
      setups: [{
        instrument: "USD/CHF", type: "MSS" as const, direction: "bearish" as const,
        description: "test", invalidation: "test",
        entry: 0.81, stop: 0.82, target: 0.79, RR: 2, timeframe: "4H",
      }],
      keyLevels: [], marketSnapshots: dxyWeaknessSnaps, assumptions: [],
    };
    expect(validateOracleOutput(oracle, []).warnings.some((w) => w.includes("r036"))).toBe(false);
  });
});

// ── r041: pre-commitment instrument screening check ───────────

describe("validateOracleOutput r041 pre-commitment check", () => {
  const weekdaySnaps = [
    { symbol: "EURUSD=X", name: "EUR/USD",     category: "forex",       price: 1.18,  previousClose: 1.17, change: 0.01, changePercent: 1.06, high: 1.19, low: 1.17, timestamp: new Date() },
    { symbol: "GBPUSD=X", name: "GBP/USD",     category: "forex",       price: 1.35,  previousClose: 1.34, change: 0.01, changePercent: 1.20, high: 1.36, low: 1.34, timestamp: new Date() },
    { symbol: "NQ=F",     name: "NASDAQ 100",  category: "indices",     price: 25000, previousClose: 24000, change: 1000, changePercent: 5.30, high: 25200, low: 24000, timestamp: new Date() },
    { symbol: "ES=F",     name: "S&P 500",     category: "indices",     price: 5500,  previousClose: 5300, change: 200,  changePercent: 3.77, high: 5520, low: 5300, timestamp: new Date() },
    { symbol: "BTC-USD",  name: "Bitcoin",     category: "crypto",      price: 74000, previousClose: 73000, change: 1000, changePercent: 1.37, high: 75000, low: 73000, timestamp: new Date() },
    { symbol: "ETH-USD",  name: "Ethereum",    category: "crypto",      price: 3000,  previousClose: 2950, change: 50,   changePercent: 1.69, high: 3050, low: 2950, timestamp: new Date() },
    { symbol: "GC=F",     name: "Gold",        category: "commodities", price: 3300,  previousClose: 3250, change: 50,   changePercent: 1.54, high: 3310, low: 3250, timestamp: new Date() },
    { symbol: "CL=F",     name: "Crude Oil",   category: "commodities", price: 90,    previousClose: 95,   change: -5,   changePercent: -5.26, high: 95, low: 89, timestamp: new Date() },
  ];

  const fullAnalysis = [
    "EUR/USD breaking above 1.18 resistance.",
    "GBP/USD at 1.35 session high.",
    "NASDAQ 100 surged +5% above 25000.",
    "S&P 500 at session highs near 5500.",
    "Bitcoin holding above 74000 support.",
    "Ethereum showing strength at 3000.",
    "Gold at 3300 resistance after rally.",
    "Crude Oil crashed to 90 support on supply shock.",
  ].join(" ");

  it("warns when confidence >55 and analysis omits required instruments", () => {
    const analysis = "EUR/USD and NASDAQ surged. Bitcoin holding support. Gold rallied.";
    // Missing: GBP/USD, S&P, Ethereum, Crude Oil
    const oracle: OracleAnalysis = {
      sessionId: "test", timestamp: new Date(),
      analysis: analysis.padEnd(300, " "),
      bias: { overall: "mixed", notes: "conflicting" }, confidence: 60,
      setups: [], keyLevels: [], marketSnapshots: weekdaySnaps, assumptions: [],
    };
    expect(validateOracleOutput(oracle, []).warnings.some((w) => w.includes("r041"))).toBe(true);
  });

  it("warns when all 8 instruments mentioned but 'Screening validation:' template absent", () => {
    // fullAnalysis mentions all 8 instruments individually — old check would pass, new check must warn
    const oracle: OracleAnalysis = {
      sessionId: "test", timestamp: new Date(),
      analysis: fullAnalysis.padEnd(300, " "),
      bias: { overall: "mixed", notes: "conflicting" }, confidence: 60,
      setups: [], keyLevels: [], marketSnapshots: weekdaySnaps, assumptions: [],
    };
    expect(validateOracleOutput(oracle, []).warnings.some((w) => w.includes("r041"))).toBe(true);
  });

  it("does not warn when analysis contains 'Screening validation:' template with all 8 instruments", () => {
    const templateAnalysis = [
      "Screening validation: EUR/USD 1.18 resistance — viable long above 1.18.",
      "GBP/USD 1.35 support — viable long on pullback.",
      "NASDAQ 25000 resistance — no setup, extended.",
      "S&P 5500 resistance — no setup, extended.",
      "BTC 74000 support — viable long.",
      "ETH 3000 support — no setup, low RR.",
      "Gold 3300 resistance — viable long breakout.",
      "Oil 90 support — no setup, conflicting bias.",
    ].join(" ");
    const oracle: OracleAnalysis = {
      sessionId: "test", timestamp: new Date(),
      analysis: templateAnalysis.padEnd(300, " "),
      bias: { overall: "mixed", notes: "conflicting" }, confidence: 60,
      setups: [], keyLevels: [], marketSnapshots: weekdaySnaps, assumptions: [],
    };
    expect(validateOracleOutput(oracle, []).warnings.some((w) => w.includes("r041"))).toBe(false);
  });

  it("does not warn when confidence is exactly 55 (threshold is >55)", () => {
    const oracle: OracleAnalysis = {
      sessionId: "test", timestamp: new Date(),
      analysis: "EUR/USD only.".padEnd(300, " "),
      bias: { overall: "mixed", notes: "conflicting" }, confidence: 55,
      setups: [], keyLevels: [], marketSnapshots: weekdaySnaps, assumptions: [],
    };
    expect(validateOracleOutput(oracle, []).warnings.some((w) => w.includes("r041"))).toBe(false);
  });

  it("does not fire on weekend-style sessions with only 2 crypto snapshots", () => {
    const cryptoOnlySnaps = [
      { symbol: "BTC-USD", name: "Bitcoin",  category: "crypto", price: 74000, previousClose: 73000, change: 1000, changePercent: 1.37, high: 75000, low: 73000, timestamp: new Date() },
      { symbol: "ETH-USD", name: "Ethereum", category: "crypto", price: 3000,  previousClose: 2950, change: 50,   changePercent: 1.69, high: 3050, low: 2950, timestamp: new Date() },
    ];
    const oracle: OracleAnalysis = {
      sessionId: "test", timestamp: new Date(),
      analysis: "Bitcoin and Ethereum showing strength today.".padEnd(300, " "),
      bias: { overall: "bullish", notes: "crypto strength" }, confidence: 60,
      setups: [], keyLevels: [], marketSnapshots: cryptoOnlySnaps, assumptions: [],
    };
    expect(validateOracleOutput(oracle, []).warnings.some((w) => w.includes("r041"))).toBe(false);
  });
});
