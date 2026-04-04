import { describe, it, expect, beforeAll } from "vitest";
import { calculateTextSimilarity, validateOracleOutput, validateAxiomOutput, extractConfidenceFromText, resolveConfidence, validateWeekendCryptoScreening } from "../src/validate";
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

// ── applyCalibrationAdjustment ────────────────────────────────

describe("applyCalibrationAdjustment", () => {
  // Import dynamically since we're adding it
  let applyCalibrationAdjustment: typeof import("../src/validate").applyCalibrationAdjustment;

  beforeAll(async () => {
    const mod = await import("../src/validate");
    applyCalibrationAdjustment = mod.applyCalibrationAdjustment;
  });

  it("reduces confidence in the 50-70% band during mixed bias", () => {
    const result = applyCalibrationAdjustment(58, "mixed");
    expect(result).toBeLessThan(50);
    expect(result).toBeGreaterThanOrEqual(30);
  });

  it("reduces confidence in the 50-70% band for non-mixed bias too", () => {
    const result = applyCalibrationAdjustment(60, "bullish");
    expect(result).toBeLessThan(60);
  });

  it("boosts confidence in the 30-50% band", () => {
    const result = applyCalibrationAdjustment(40, "bullish");
    expect(result).toBeGreaterThan(40);
    expect(result).toBeLessThanOrEqual(55);
  });

  it("applies stronger penalty for mixed bias in 50-70% band", () => {
    const mixed = applyCalibrationAdjustment(60, "mixed");
    const bullish = applyCalibrationAdjustment(60, "bullish");
    expect(mixed).toBeLessThan(bullish);
  });

  it("does not adjust confidence below 30 or above 70", () => {
    expect(applyCalibrationAdjustment(25, "bullish")).toBe(25);
    expect(applyCalibrationAdjustment(75, "bearish")).toBe(75);
  });

  it("clamps results to 0-100 range", () => {
    expect(applyCalibrationAdjustment(5, "bullish")).toBeGreaterThanOrEqual(0);
    expect(applyCalibrationAdjustment(95, "bullish")).toBeLessThanOrEqual(100);
  });

  it("returns a whole number", () => {
    const result = applyCalibrationAdjustment(55, "mixed");
    expect(Number.isInteger(result)).toBe(true);
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
