import { describe, it, expect, vi, beforeEach } from "vitest";
import { buildAxiomPrompt, parseAxiomResponse, handleSelfTasks, isThemeDuplicate } from "../src/axiom";
import type { OracleAnalysis, AnalysisRules } from "../src/types";

function makeOracle(overrides: Partial<OracleAnalysis> = {}): OracleAnalysis {
  return {
    timestamp: new Date(),
    sessionId: "nx-test-123",
    marketSnapshots: [],
    analysis: "Test analysis with some content about the market conditions observed today.",
    setups: [
      {
        instrument: "EUR/USD",
        type: "FVG",
        direction: "bullish",
        description: "Fair value gap at 1.0850",
        invalidation: "Below 1.0800",
        entry: 1.085,
        stop: 1.08,
        target: 1.095,
        RR: 2,
        timeframe: "4H",
      },
    ],
    bias: { overall: "bullish", notes: "Strong bullish momentum" },
    keyLevels: [],
    confidence: 72,
    ...overrides,
  };
}

function makeRules(overrides: Partial<AnalysisRules> = {}): AnalysisRules {
  return {
    version: 5,
    lastUpdated: "2025-01-01",
    rules: [
      { id: "r001", category: "methodology", description: "Always use ICT", weight: 10, addedSession: 1, lastModifiedSession: 1 },
      { id: "r002", category: "risk", description: "Max 2% risk per trade", weight: 9, addedSession: 1, lastModifiedSession: 1 },
    ],
    focusInstruments: ["EUR/USD"],
    sessionNotes: "",
    ...overrides,
  };
}

// ── buildAxiomPrompt ──────────────────────────────────────

describe("buildAxiomPrompt", () => {
  it("returns systemMessage and userMessage", () => {
    const oracle = makeOracle();
    const rules = makeRules();
    const result = buildAxiomPrompt(oracle, 5, "", "", "", 0, "", rules, "");
    expect(result).toHaveProperty("systemMessage");
    expect(result).toHaveProperty("userMessage");
    expect(typeof result.systemMessage).toBe("string");
    expect(typeof result.userMessage).toBe("string");
  });

  it("includes session number in user message", () => {
    const oracle = makeOracle();
    const rules = makeRules();
    const { userMessage } = buildAxiomPrompt(oracle, 42, "", "", "", 0, "", rules, "");
    expect(userMessage).toContain("Session #42");
  });

  it("includes oracle analysis text", () => {
    const oracle = makeOracle({ analysis: "Unique analysis content XYZ" });
    const rules = makeRules();
    const { userMessage } = buildAxiomPrompt(oracle, 1, "", "", "", 0, "", rules, "");
    expect(userMessage).toContain("Unique analysis content XYZ");
  });

  it("includes setup details", () => {
    const oracle = makeOracle();
    const rules = makeRules();
    const { userMessage } = buildAxiomPrompt(oracle, 1, "", "", "", 0, "", rules, "");
    expect(userMessage).toContain("EUR/USD");
    expect(userMessage).toContain("FVG");
    expect(userMessage).toContain("COMPLETE");
  });

  it("marks incomplete setups", () => {
    const oracle = makeOracle({
      setups: [{
        instrument: "GBP/USD", type: "OB", direction: "bearish",
        description: "test", invalidation: "test",
      }],
    });
    const rules = makeRules();
    const { userMessage } = buildAxiomPrompt(oracle, 1, "", "", "", 0, "", rules, "");
    expect(userMessage).toContain("INCOMPLETE");
    expect(userMessage).toContain("MISSING");
  });

  it("includes rules in prompt", () => {
    const oracle = makeOracle();
    const rules = makeRules();
    const { userMessage } = buildAxiomPrompt(oracle, 1, "", "", "", 0, "", rules, "");
    expect(userMessage).toContain("[r001]");
    expect(userMessage).toContain("Always use ICT");
    expect(userMessage).toContain("2 active rules");
  });

  it("includes previous sessions when provided", () => {
    const oracle = makeOracle();
    const rules = makeRules();
    const { userMessage } = buildAxiomPrompt(oracle, 2, "Session #1: previous data", "", "", 0, "", rules, "");
    expect(userMessage).toContain("Session #1: previous data");
  });

  it("includes community issues when provided", () => {
    const oracle = makeOracle();
    const rules = makeRules();
    const { userMessage } = buildAxiomPrompt(oracle, 1, "", "Issue #5: Add BTC analysis", "", 0, "", rules, "");
    expect(userMessage).toContain("Issue #5: Add BTC analysis");
  });

  it("includes stagnation alert when streak >= 3", () => {
    const oracle = makeOracle();
    const rules = makeRules();
    const { userMessage } = buildAxiomPrompt(oracle, 1, "", "", "", 3, "", rules, "");
    expect(userMessage).toContain("STAGNATION ALERT");
    expect(userMessage).toContain("3 consecutive sessions");
  });

  it("does not include stagnation alert when streak < 3", () => {
    const oracle = makeOracle();
    const rules = makeRules();
    const { userMessage } = buildAxiomPrompt(oracle, 1, "", "", "", 2, "", rules, "");
    expect(userMessage).not.toContain("STAGNATION ALERT");
  });

  it("prepends identity context to system message when provided", () => {
    const oracle = makeOracle();
    const rules = makeRules();
    const { systemMessage } = buildAxiomPrompt(oracle, 1, "", "", "", 0, "", rules, "NEXUS IDENTITY DOCUMENT");
    expect(systemMessage).toContain("NEXUS IDENTITY DOCUMENT");
    expect(systemMessage).toContain("NEXUS AXIOM");
    // Identity comes first
    expect(systemMessage.indexOf("NEXUS IDENTITY DOCUMENT")).toBeLessThan(systemMessage.indexOf("NEXUS AXIOM"));
  });

  it("does not prepend identity when empty", () => {
    const oracle = makeOracle();
    const rules = makeRules();
    const { systemMessage } = buildAxiomPrompt(oracle, 1, "", "", "", 0, "", rules, "");
    expect(systemMessage).not.toContain("NEXUS IDENTITY DOCUMENT");
    expect(systemMessage.startsWith("You are NEXUS AXIOM")).toBe(true);
  });

  it("includes setup outcomes when provided", () => {
    const oracle = makeOracle();
    const rules = makeRules();
    const { userMessage } = buildAxiomPrompt(oracle, 1, "", "", "", 0, "EUR/USD BULLISH TARGET HIT", rules, "");
    expect(userMessage).toContain("Setup outcome tracking");
    expect(userMessage).toContain("EUR/USD BULLISH TARGET HIT");
  });

  it("includes confidence and bias info", () => {
    const oracle = makeOracle({ confidence: 85, bias: { overall: "bearish", notes: "Weak structure" } });
    const rules = makeRules();
    const { userMessage } = buildAxiomPrompt(oracle, 1, "", "", "", 0, "", rules, "");
    expect(userMessage).toContain("85/100");
    expect(userMessage).toContain("bearish");
    expect(userMessage).toContain("Weak structure");
  });
});

// ── parseAxiomResponse ────────────────────────────────────

describe("parseAxiomResponse", () => {
  const rules = makeRules();

  it("parses valid JSON response", () => {
    const json = JSON.stringify({
      whatWorked: "Good analysis",
      whatFailed: "Missing setups",
      cognitiveBiases: ["recency bias"],
      evolutionSummary: "Learned something new",
      ruleUpdates: [],
      newRules: [],
      systemPromptAdditions: "",
      newSelfTasks: [],
      resolvedSelfTasks: [],
      codeChanges: [],
    });
    const result = parseAxiomResponse(json, 1, rules);
    expect(result.whatWorked).toBe("Good analysis");
    expect(result.whatFailed).toBe("Missing setups");
    expect(result.cognitiveBiases).toEqual(["recency bias"]);
  });

  it("extracts JSON from markdown code blocks", () => {
    const rawText = "Here is my reflection:\n```json\n" + JSON.stringify({
      whatWorked: "Wrapped in code block",
      whatFailed: "Some issues were found in the analysis",
      cognitiveBiases: ["recency bias"],
      evolutionSummary: "Learned something new and significant about market analysis today",
      ruleUpdates: [],
      newRules: [],
      systemPromptAdditions: "",
      newSelfTasks: [],
      resolvedSelfTasks: [],
      codeChanges: [],
    }) + "\n```";
    const result = parseAxiomResponse(rawText, 1, rules);
    expect(result.whatWorked).toBe("Wrapped in code block");
  });

  it("returns fallback on completely unparseable input", () => {
    const result = parseAxiomResponse("This is not JSON at all", 1, rules);
    expect(result.whatWorked).toBeDefined();
    expect(result.evolutionSummary).toContain("failed");
  });

  it("sanitizes rule updates through security", () => {
    const json = JSON.stringify({
      whatWorked: "OK",
      whatFailed: "OK",
      cognitiveBiases: [],
      evolutionSummary: "OK",
      ruleUpdates: [{ ruleId: "r001", type: "modify", before: "old", after: "new", reason: "test" }],
      newRules: [],
      systemPromptAdditions: "",
      newSelfTasks: [],
      resolvedSelfTasks: [],
      codeChanges: [],
    });
    const result = parseAxiomResponse(json, 1, rules);
    // ruleUpdates should pass through security sanitization
    expect(result.ruleUpdates).toBeDefined();
    expect(Array.isArray(result.ruleUpdates)).toBe(true);
  });
});

// ── isThemeDuplicate ─────────────────────────────────────

describe("isThemeDuplicate", () => {
  // Real examples from NEXUS session #134-#139: same "resist narrative dominance"
  // theme expressed in different words — current 0.55 Jaccard misses these
  const narrativeSection134 =
    "Resist the temptation to attribute everything to a single narrative. " +
    "Coordinated breakouts can result from technical confluence, positioning unwinding, " +
    "algorithmic triggers, or multiple simultaneous catalysts. Maintain analytical " +
    "independence by developing competing explanations before settling on primary causation.";

  const narrativeSection135 =
    "During major market moves exceeding 2x typical ranges across multiple asset classes, " +
    "resist single-narrative dominance by systematically considering at least two competing " +
    "explanations for the price action, even when one narrative appears to explain all movements " +
    "coherently. Geopolitical events, central bank actions, and technical factors can simultaneously " +
    "drive markets — analytical independence requires maintaining multiple causation pathways.";

  const narrativeSection138 =
    "When multiple plausible explanations exist for complex market moves, assign equal probability " +
    "weighting to each pathway rather than defaulting to the most coherent narrative. Coherence is " +
    "not the same as accuracy in financial markets - randomness often produces patterns that appear " +
    "systematic but lack predictive value.";

  const weekendSection =
    "Weekend crypto sessions require systematic setup generation discipline - analytical observations " +
    "must convert to actionable structures. Positive sector-aligned performance without corresponding " +
    "setups indicates execution gap, not data limitation.";

  const oilSection =
    "When major commodities like oil move more than 5% intraday, distinguish between supply-shock " +
    "momentum which tends to continue 2-3 sessions and speculative exhaustion which reverses within " +
    "1 session. Oil moves exceeding 8% typically require 24-48 hour consolidation before next directional leg.";

  it("detects same narrative-dominance theme expressed in different words (the real stagnation case)", () => {
    const result = isThemeDuplicate(narrativeSection138, [narrativeSection134, narrativeSection135]);
    expect(result.isDuplicate).toBe(true);
  });

  it("does not flag genuinely different themes as duplicates", () => {
    const result = isThemeDuplicate(oilSection, [narrativeSection134, weekendSection]);
    expect(result.isDuplicate).toBe(false);
  });

  it("returns conflictingSection when duplicate detected", () => {
    const result = isThemeDuplicate(narrativeSection135, [narrativeSection134]);
    expect(result.isDuplicate).toBe(true);
    expect(result.conflictingSection).not.toBeNull();
  });

  it("detects exact duplicates (existing 0.55 Jaccard behavior preserved)", () => {
    const result = isThemeDuplicate(narrativeSection134, [narrativeSection134]);
    expect(result.isDuplicate).toBe(true);
  });

  it("returns false with empty existing sections", () => {
    const result = isThemeDuplicate(narrativeSection134, []);
    expect(result.isDuplicate).toBe(false);
    expect(result.conflictingSection).toBeNull();
  });

  it("does not flag weekend theme against narrative theme", () => {
    const result = isThemeDuplicate(weekendSection, [narrativeSection134, narrativeSection135]);
    expect(result.isDuplicate).toBe(false);
  });
});

// ── handleSelfTasks ───────────────────────────────────────

describe("handleSelfTasks", () => {
  it("does nothing when no tasks provided", async () => {
    // Should not throw
    await handleSelfTasks({ newSelfTasks: [], resolvedSelfTasks: [] }, [], 1);
  });

  it("does nothing when fields are undefined", async () => {
    await handleSelfTasks({}, [], 1);
  });
});
