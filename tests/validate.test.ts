import { describe, it, expect } from "vitest";
import { calculateTextSimilarity, validateOracleOutput, validateAxiomOutput } from "../src/validate";
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
