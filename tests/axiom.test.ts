import { describe, it, expect, vi, beforeEach } from "vitest";
import { buildAxiomPrompt, parseAxiomResponse, handleSelfTasks, isThemeDuplicate, sanitizeRulesText, buildR011ComplianceNote } from "../src/axiom";
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

  it("includes r029 per-instrument note listing only volatile instruments when session has extreme mover", () => {
    const snapshots = [
      { name: "Crude Oil", symbol: "OIL", category: "commodities" as const, price: 91, previousClose: 99, change: -8, changePercent: -7.82, high: 99, low: 91, timestamp: new Date() },
      { name: "EUR/USD",   symbol: "EURUSD", category: "forex" as const, price: 1.178, previousClose: 1.169, change: 0.009, changePercent: 0.75, high: 1.18, low: 1.17, timestamp: new Date() },
    ];
    const oracle = makeOracle({ marketSnapshots: snapshots });
    const rules = makeRules();
    const { userMessage } = buildAxiomPrompt(oracle, 1, "", "", "", 0, "", rules, "");
    // Should tell AXIOM which instruments r029 applies to
    expect(userMessage).toMatch(/r029 applies only to|r029 applies ONLY to/i);
    expect(userMessage).toContain("Crude Oil");
    // Should explicitly exempt EUR/USD
    expect(userMessage).toContain("EUR/USD");
    expect(userMessage).toMatch(/EUR\/USD.*NOT subject|NOT.*r029.*EUR\/USD|no.*r029.*requirement.*EUR\/USD/i);
  });

  it("does not include r029 per-instrument note when no instruments moved ≥3%", () => {
    const snapshots = [
      { name: "EUR/USD", symbol: "EURUSD", category: "forex" as const, price: 1.178, previousClose: 1.169, change: 0.009, changePercent: 0.75, high: 1.18, low: 1.17, timestamp: new Date() },
      { name: "GBP/USD", symbol: "GBPUSD", category: "forex" as const, price: 1.35, previousClose: 1.34, change: 0.01, changePercent: 0.75, high: 1.36, low: 1.34, timestamp: new Date() },
    ];
    const oracle = makeOracle({ marketSnapshots: snapshots });
    const rules = makeRules();
    const { userMessage } = buildAxiomPrompt(oracle, 1, "", "", "", 0, "", rules, "");
    expect(userMessage).not.toContain("r029 applies only to");
  });

  it("lists both extreme and moderate volatile instruments in r029 note", () => {
    const snapshots = [
      { name: "Crude Oil", symbol: "OIL", category: "commodities" as const, price: 91, previousClose: 99, change: -8, changePercent: -7.82, high: 99, low: 91, timestamp: new Date() },
      { name: "Silver",   symbol: "XAG", category: "commodities" as const, price: 32, previousClose: 31, change: 1, changePercent: 3.5, high: 32.5, low: 31, timestamp: new Date() },
      { name: "EUR/USD",  symbol: "EURUSD", category: "forex" as const, price: 1.178, previousClose: 1.169, change: 0.009, changePercent: 0.75, high: 1.18, low: 1.17, timestamp: new Date() },
    ];
    const oracle = makeOracle({ marketSnapshots: snapshots });
    const rules = makeRules();
    const { userMessage } = buildAxiomPrompt(oracle, 1, "", "", "", 0, "", rules, "");
    expect(userMessage).toContain("Crude Oil");
    expect(userMessage).toContain("Silver");
    // EUR/USD should be explicitly exempted
    expect(userMessage).toMatch(/EUR\/USD.*NOT subject|NOT.*r029.*EUR\/USD|no.*r029.*requirement.*EUR\/USD/i);
  });

  it("shows per-setup r029 COMPLIANT status for low-move instrument with tight stop", () => {
    // EUR/USD moved 0.75% — no r029 minimum. Tight stop should be COMPLIANT.
    const snapshots = [
      { name: "Crude Oil", symbol: "OIL",    category: "commodities" as const, price: 91,    previousClose: 99,    change: -8,    changePercent: -7.82, high: 99,    low: 91,    timestamp: new Date() },
      { name: "EUR/USD",   symbol: "EURUSD", category: "forex" as const,       price: 1.1781, previousClose: 1.169, change: 0.009, changePercent: 0.75,  high: 1.18,  low: 1.17,  timestamp: new Date() },
    ];
    const setups: any[] = [
      { instrument: "EUR/USD", type: "MSS", direction: "bullish", description: "test", invalidation: "test",
        entry: 1.1781, stop: 1.174, target: 1.19, RR: 1.68, timeframe: "4H" },
    ];
    const oracle = makeOracle({ marketSnapshots: snapshots, setups });
    const rules = makeRules();
    const { userMessage } = buildAxiomPrompt(oracle, 1, "", "", "", 0, "", rules, "");
    // EUR/USD stop is 0.35%, but EUR/USD moved 0.75% — no r029 minimum → COMPLIANT
    expect(userMessage).toMatch(/EUR\/USD.*COMPLIANT|COMPLIANT.*EUR\/USD/i);
    expect(userMessage).toMatch(/no.*minimum|no.*requirement|no.*r029/i);
  });

  it("shows per-setup r029 COMPLIANT status for Oil setup meeting 1.5% requirement", () => {
    const snapshots = [
      { name: "Crude Oil", symbol: "OIL", category: "commodities" as const, price: 91.47, previousClose: 99.5, change: -8.03, changePercent: -8.07, high: 99, low: 91, timestamp: new Date() },
    ];
    const setups: any[] = [
      { instrument: "Crude Oil", type: "Liquidity Sweep", direction: "bearish", description: "test", invalidation: "test",
        entry: 91.47, stop: 95, target: 85, RR: 1.83, timeframe: "4H" },
    ];
    const oracle = makeOracle({ marketSnapshots: snapshots, setups });
    const rules = makeRules();
    const { userMessage } = buildAxiomPrompt(oracle, 1, "", "", "", 0, "", rules, "");
    // Oil stop is 3.86% — above 1.5% requirement → COMPLIANT
    expect(userMessage).toMatch(/Crude Oil.*COMPLIANT|COMPLIANT.*Crude Oil/i);
  });

  it("shows per-setup r029 VIOLATION for Oil setup with stop below 1.5%", () => {
    const snapshots = [
      { name: "Crude Oil", symbol: "OIL", category: "commodities" as const, price: 91.47, previousClose: 99.5, change: -8.03, changePercent: -8.07, high: 99, low: 91, timestamp: new Date() },
    ];
    const setups: any[] = [
      { instrument: "Crude Oil", type: "Liquidity Sweep", direction: "bearish", description: "test", invalidation: "test",
        entry: 91.47, stop: 92, target: 85, RR: 1.83, timeframe: "4H" }, // stop is only 0.58% — violation
    ];
    const oracle = makeOracle({ marketSnapshots: snapshots, setups });
    const rules = makeRules();
    const { userMessage } = buildAxiomPrompt(oracle, 1, "", "", "", 0, "", rules, "");
    expect(userMessage).toMatch(/Crude Oil.*VIOLATION|VIOLATION.*Crude Oil/i);
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

  // ── Morphological variant tests (backlog #7) ──────────────
  // These are the cases that slipped through: same theme, different word forms.
  // "execution/setup generation failures" expressed across sessions using
  // execute/executing/executed and generate/generating/generation etc.

  const execGapSession1 =
    "When systematic execution failures occur across multiple asset classes, " +
    "document the analytical gap and generate actionable setups rather than " +
    "simply noting the price action. Execution discipline requires converting " +
    "observations into structured trade plans.";

  const execGapSession2 =
    "Systematic analysis of coordinated market moves must generate executable " +
    "setups. Analytical observations without actionable structures indicate an " +
    "execution gap — market intelligence requires conversion of insights into " +
    "specific entry, stop, and target levels.";

  const execGapSession3 =
    "Setup generation failures during high-conviction sessions indicate executing " +
    "discipline gaps. Converting analytical observations into structured setups is " +
    "non-negotiable — generated intelligence without corresponding trade structures " +
    "represents incomplete analysis regardless of narrative quality.";

  it("detects morphological variants of execution/setup theme (session1 vs session2)", () => {
    const result = isThemeDuplicate(execGapSession2, [execGapSession1]);
    expect(result.isDuplicate).toBe(true);
  });

  it("detects morphological variants of execution/setup theme (session3 vs session1)", () => {
    const result = isThemeDuplicate(execGapSession3, [execGapSession1]);
    expect(result.isDuplicate).toBe(true);
  });

  it("does not flag execution-gap theme against narrative-dominance theme", () => {
    const result = isThemeDuplicate(execGapSession1, [narrativeSection134, narrativeSection135]);
    expect(result.isDuplicate).toBe(false);
  });

  it("does not flag oil-volatility theme against execution-gap theme", () => {
    const result = isThemeDuplicate(oilSection, [execGapSession1, execGapSession2]);
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

// ── parseAxiomResponse — forced self-task injection ──────────

describe("parseAxiomResponse forced self-task injection", () => {
  const rules = makeRules();

  it("injects a forced self-task when axiom acknowledges compliance violation without any action", () => {
    const json = JSON.stringify({
      whatWorked: "Good cross-asset analysis structure",
      whatFailed: "Critical compliance failure on r029 stop distances violated minimum requirements during extreme volatility",
      cognitiveBiases: ["implementation bias"],
      evolutionSummary: "Identified stop distance execution gap that needs systematic enforcement",
      ruleUpdates: [], newRules: [],
      systemPromptAdditions: "",
      newSelfTasks: [], resolvedSelfTasks: [], codeChanges: [],
    });
    const result = parseAxiomResponse(json, 150, rules);
    expect(Array.isArray(result.newSelfTasks)).toBe(true);
    expect(result.newSelfTasks.length).toBeGreaterThan(0);
    expect(result.newSelfTasks.some((t: any) => t.category === "rule-gap")).toBe(true);
  });

  it("uses first sentence of whatFailed as the injected task title", () => {
    const json = JSON.stringify({
      whatWorked: "Good analysis",
      whatFailed: "Systematic failure to screen commodities asset class. Oil was mentioned but no structural level evaluation documented.",
      cognitiveBiases: ["anchoring bias"],
      evolutionSummary: "Execution gap on commodities screening",
      ruleUpdates: [], newRules: [], systemPromptAdditions: "",
      newSelfTasks: [], resolvedSelfTasks: [], codeChanges: [],
    });
    const result = parseAxiomResponse(json, 150, rules);
    const injected = (result.newSelfTasks ?? []).find((t: any) => t.category === "rule-gap");
    expect(injected).toBeDefined();
    expect(injected.title).toContain("Systematic failure to screen commodities");
    expect(injected.title).not.toContain("r029");
    expect(injected.body).toContain("Oil was mentioned");
  });

  it("does not inject self-task when rule update accompanies the violation acknowledgement", () => {
    const json = JSON.stringify({
      whatWorked: "Good analysis",
      whatFailed: "Compliance failure on r029 stop distances were too narrow",
      cognitiveBiases: [],
      evolutionSummary: "Updated stop rule to enforce wider distances",
      ruleUpdates: [{ ruleId: "r029", type: "modify", before: "old text", after: "new text", reason: "enforce stop distance" }],
      newRules: [], systemPromptAdditions: "",
      newSelfTasks: [], resolvedSelfTasks: [], codeChanges: [],
    });
    const result = parseAxiomResponse(json, 150, rules);
    // No forced injection since a rule update is present
    const forcedCount = (result.newSelfTasks ?? []).filter((t: any) => t.category === "rule-gap").length;
    expect(forcedCount).toBe(0);
  });

  it("does not inject duplicate when axiom already created a rule-gap self-task", () => {
    const json = JSON.stringify({
      whatWorked: "Good analysis",
      whatFailed: "Compliance violation on stop distances",
      cognitiveBiases: [],
      evolutionSummary: "Need to enforce stops at generation layer",
      ruleUpdates: [], newRules: [], systemPromptAdditions: "",
      newSelfTasks: [{ title: "Enforce stop validation", body: "Fix stop enforcement", category: "rule-gap", priority: "high" }],
      resolvedSelfTasks: [], codeChanges: [],
    });
    const result = parseAxiomResponse(json, 150, rules);
    const ruleGapCount = (result.newSelfTasks ?? []).filter((t: any) => t.category === "rule-gap").length;
    expect(ruleGapCount).toBe(1); // only the one AXIOM already created, not a duplicate
  });

  it("suppresses r029 self-task when AXIOM falsely claims violations but all setups are per-instrument compliant", () => {
    // Session #183 pattern: Oil -8.17% extreme, EUR/USD +0.79% and EUR/JPY +0.84% (both <3%, no r029 req)
    // AXIOM falsely flags EUR/USD and EUR/JPY stops as r029 violations
    const oracle = makeOracle({
      marketSnapshots: [
        { name: "Crude Oil", symbol: "OIL",    category: "commodities" as const, price: 91,     previousClose: 99,    change: -8,    changePercent: -8.17, high: 99,   low: 91,   timestamp: new Date() },
        { name: "EUR/USD",   symbol: "EURUSD",  category: "forex" as const,       price: 1.1783, previousClose: 1.169, change: 0.009, changePercent: 0.79,  high: 1.18, low: 1.17, timestamp: new Date() },
        { name: "EUR/JPY",   symbol: "EURJPY",  category: "forex" as const,       price: 187.55, previousClose: 186,   change: 1.55,  changePercent: 0.84,  high: 188,  low: 186,  timestamp: new Date() },
      ] as any,
      setups: [
        { instrument: "EUR/USD", type: "MSS",  direction: "bullish", description: "test", invalidation: "test", entry: 1.1783, stop: 1.176,  target: 1.182, RR: 1.61, timeframe: "1H" },
        { instrument: "EUR/JPY", type: "MSS",  direction: "bullish", description: "test", invalidation: "test", entry: 187.55, stop: 186.5, target: 189,   RR: 1.38, timeframe: "1H" },
      ] as any,
    });
    const json = JSON.stringify({
      whatWorked: "Good analysis",
      whatFailed: "EUR/USD 0.20% and EUR/JPY 0.56% stops both below required 1.5% during extreme volatility — r029 stop distance violation for fourth consecutive session",
      cognitiveBiases: ["enforcement bias"],
      evolutionSummary: "Need code-level enforcement",
      ruleUpdates: [], newRules: [], systemPromptAdditions: "",
      newSelfTasks: [], resolvedSelfTasks: [], codeChanges: [],
    });
    const result = parseAxiomResponse(json, 183, rules, oracle);
    // All setups are compliant (EUR/USD and EUR/JPY both moved <3%) — false positive must be suppressed
    const ruleGapCount = (result.newSelfTasks ?? []).filter((t: any) => t.category === "rule-gap").length;
    expect(ruleGapCount).toBe(0);
  });

  it("does NOT suppress r029 self-task when a setup truly violates r029 (Oil tight stop)", () => {
    // Oil moved -8.17% (extreme) — Oil setup has 0.58% stop which IS a real violation (< 1.5%)
    const oracle = makeOracle({
      marketSnapshots: [
        { name: "Crude Oil", symbol: "OIL", category: "commodities" as const, price: 91.47, previousClose: 99.5, change: -8.03, changePercent: -8.17, high: 99, low: 91, timestamp: new Date() },
      ] as any,
      setups: [
        { instrument: "Crude Oil", type: "Liquidity Sweep", direction: "bearish", description: "test", invalidation: "test", entry: 91.47, stop: 92, target: 85, RR: 1.83, timeframe: "4H" },
      ] as any,
    });
    const json = JSON.stringify({
      whatWorked: "Good analysis",
      whatFailed: "Crude Oil stop is only 0.58% during extreme session — r029 violation, requires 1.5% minimum",
      cognitiveBiases: [],
      evolutionSummary: "Need wider stops on volatile instruments",
      ruleUpdates: [], newRules: [], systemPromptAdditions: "",
      newSelfTasks: [], resolvedSelfTasks: [], codeChanges: [],
    });
    const result = parseAxiomResponse(json, 183, rules, oracle);
    // Oil truly violated r029 — self-task should be injected
    const ruleGapCount = (result.newSelfTasks ?? []).filter((t: any) => t.category === "rule-gap").length;
    expect(ruleGapCount).toBe(1);
  });
});

// ── buildAxiomPrompt — session type context ───────────────

describe("buildAxiomPrompt session type", () => {
  it("includes WEEKDAY context when isWeekend=false", () => {
    const { userMessage } = buildAxiomPrompt(makeOracle(), 1, "", "", "", 0, "", makeRules(), "", false);
    expect(userMessage.toLowerCase()).toContain("weekday");
  });

  it("includes WEEKEND context when isWeekend=true", () => {
    const { userMessage } = buildAxiomPrompt(makeOracle(), 1, "", "", "", 0, "", makeRules(), "", true);
    expect(userMessage.toLowerCase()).toContain("weekend");
  });

  it("weekday message notes that weekend crypto rules do not apply", () => {
    const { userMessage } = buildAxiomPrompt(makeOracle(), 1, "", "", "", 0, "", makeRules(), "", false);
    expect(userMessage).toMatch(/weekday|weekend.*not apply|r030.*not apply/i);
  });

  it("defaults to weekday (false) when isWeekend not provided", () => {
    // Old 9-arg call still compiles and defaults to weekday
    const { userMessage } = buildAxiomPrompt(makeOracle(), 1, "", "", "", 0, "", makeRules(), "");
    expect(userMessage.toLowerCase()).toContain("weekday");
  });
});

// ── buildAxiomPrompt — FORGE escalation for persistent zero-setup sessions (#33) ──
// When NEXUS produces zero setups in 3+ consecutive sessions, AXIOM must be forced
// to raise a FORGE codeChanges entry. Rule modifications alone have not resolved the
// pattern in sessions #185-#188.

describe("buildAxiomPrompt FORGE escalation", () => {
  it("includes FORGE escalation when consecutiveZeroSetupCount >= 3", () => {
    const { userMessage } = buildAxiomPrompt(makeOracle(), 190, "", "", "", 0, "", makeRules(), "", false, 3);
    expect(userMessage).toMatch(/FORGE.*ESCALATION|ESCALATION.*REQUIRED|codeChanges.*MANDATORY|MANDATORY.*codeChanges/i);
  });

  it("includes the consecutive count in the escalation message", () => {
    const { userMessage } = buildAxiomPrompt(makeOracle(), 190, "", "", "", 0, "", makeRules(), "", false, 4);
    expect(userMessage).toContain("4");
  });

  it("states that rule modifications alone have not resolved the pattern", () => {
    const { userMessage } = buildAxiomPrompt(makeOracle(), 190, "", "", "", 0, "", makeRules(), "", false, 3);
    expect(userMessage.toLowerCase()).toMatch(/rule.*not.*resolv|modification.*not.*resolv/i);
  });

  it("explicitly requires codeChanges this session", () => {
    const { userMessage } = buildAxiomPrompt(makeOracle(), 190, "", "", "", 0, "", makeRules(), "", false, 3);
    expect(userMessage.toLowerCase()).toContain("codechanges");
  });

  it("does NOT include FORGE escalation when consecutiveZeroSetupCount < 3", () => {
    const { userMessage } = buildAxiomPrompt(makeOracle(), 190, "", "", "", 0, "", makeRules(), "", false, 2);
    expect(userMessage).not.toMatch(/FORGE.*ESCALATION|ESCALATION.*REQUIRED|codeChanges.*MANDATORY/i);
  });

  it("does NOT include FORGE escalation when consecutiveZeroSetupCount is 0 (default)", () => {
    const { userMessage } = buildAxiomPrompt(makeOracle(), 190, "", "", "", 0, "", makeRules(), "", false);
    expect(userMessage).not.toMatch(/FORGE.*ESCALATION|ESCALATION.*REQUIRED|codeChanges.*MANDATORY/i);
  });

  it("escalation fires at exactly 3 consecutive zero-setup sessions", () => {
    const at3 = buildAxiomPrompt(makeOracle(), 190, "", "", "", 0, "", makeRules(), "", false, 3).userMessage;
    const at2 = buildAxiomPrompt(makeOracle(), 190, "", "", "", 0, "", makeRules(), "", false, 2).userMessage;
    expect(at3).toMatch(/FORGE.*ESCALATION|ESCALATION.*REQUIRED|codeChanges.*MANDATORY/i);
    expect(at2).not.toMatch(/FORGE.*ESCALATION|ESCALATION.*REQUIRED|codeChanges.*MANDATORY/i);
  });
});

// ── sanitizeRulesText — encoding corruption repair ────────────

describe("sanitizeRulesText", () => {
  // The mojibake sequence: Windows-1252 bytes of em-dash (E2 80 94)
  // decoded as individual chars U+00E2, U+20AC, U+201D → "â€""
  const MOJO = "\u00e2\u20ac\u201d";
  const EM   = "\u2014"; // proper em-dash —

  function makeRulesWithMojo(): AnalysisRules {
    return {
      rules: [
        { id: "r004", category: "liquidity", description: `Equal highs/lows are liquidity targets ${MOJO} price is drawn to them`, weight: 8, addedSession: 1, lastModifiedSession: 1 },
        { id: "r016", category: "structure", description: "Normal rule no dash", weight: 5, addedSession: 1, lastModifiedSession: 1, disabled: true, disabledReason: `Requires candle data ${MOJO} re-enable later` },
        { id: "r099", category: "misc",      description: "No corruption here",  weight: 5, addedSession: 1, lastModifiedSession: 1 },
      ],
      version: 5,
      lastUpdated: "2026-04-15T00:00:00Z",
      focusInstruments: [],
      sessionNotes: "test",
    } as any;
  }

  it("replaces mojibake em-dash sequence with proper em-dash in description", () => {
    const result = sanitizeRulesText(makeRulesWithMojo());
    const r004 = result.rules.find(r => r.id === "r004")!;
    expect(r004.description).not.toContain(MOJO);
    expect(r004.description).toContain(EM);
  });

  it("replaces mojibake in disabledReason field", () => {
    const result = sanitizeRulesText(makeRulesWithMojo());
    const r016 = result.rules.find(r => r.id === "r016")!;
    expect((r016 as any).disabledReason).not.toContain(MOJO);
    expect((r016 as any).disabledReason).toContain(EM);
  });

  it("leaves clean rules untouched", () => {
    const result = sanitizeRulesText(makeRulesWithMojo());
    const r099 = result.rules.find(r => r.id === "r099")!;
    expect(r099.description).toBe("No corruption here");
  });

  it("handles multiple occurrences in one description", () => {
    const rules = makeRulesWithMojo();
    rules.rules[0].description = `A ${MOJO} B ${MOJO} C`;
    const result = sanitizeRulesText(rules);
    expect(result.rules[0].description).toBe(`A ${EM} B ${EM} C`);
    expect(result.rules[0].description).not.toContain(MOJO);
  });
});

// ── parseAxiomResponse field-boundary salvage ─────────────
// Backlog #43: sessions #208 and #215 produced "JSON parse error" sentinel.
// parseAxiomResponse currently tries JSON.parse → salvageJSON → empty fallback.
// oracle.ts uses a field-boundary cut (slicing at `", "` boundaries) when
// salvageJSON fails. This test verifies the same pattern is applied to AXIOM.

describe("parseAxiomResponse field-boundary salvage", () => {
  it("recovers AXIOM response when a non-required field has invalid content (null byte)", () => {
    // systemPromptAdditions has a null byte (\x00) — invalid JSON content.
    // JSON.parse fails. salvageJSON also fails (can't repair content, only structure).
    // Field-boundary cut recovers the 4 required fields from before the broken field.
    // systemPromptAdditions is placed right after evolutionSummary (string→string
    // transition) so a `", "` boundary exists for the cutter.
    const rawText =
      '{"whatWorked": "Strong screening compliance", ' +
      '"whatFailed": "r011 attribution gap persists", ' +
      '"cognitiveBiases": ["attribution bias"], ' +
      '"evolutionSummary": "Need pre-commitment injection for r011", ' +
      '"systemPromptAdditions": "Add \x00 invalid control char here"}';

    const rules = makeRules();
    const result = parseAxiomResponse(rawText, 1, rules);

    // Must NOT fall back to empty-reflection sentinel values
    expect(result.whatWorked).not.toBe("Unable to parse reflection");
    expect(result.whatWorked).not.toBe("Validation failed");
    // Must recover the clean earlier fields
    expect(result.whatWorked).toBe("Strong screening compliance");
    expect(result.whatFailed).toBe("r011 attribution gap persists");
  });

  it("returns normal sentinel when every field is broken (unrecoverable)", () => {
    // Completely unparseable — not even a partial recovery is possible
    const rawText = "not json at all \x00\x01\x02 completely broken";
    const rules = makeRules();
    const result = parseAxiomResponse(rawText, 1, rules);
    // Should get one of the two sentinel values (parse failure or validation failure)
    const sentinels = ["Unable to parse reflection", "Validation failed"];
    expect(sentinels).toContain(result.whatWorked);
  });
});

// ── buildR011ComplianceNote ───────────────────────────────

describe("buildR011ComplianceNote", () => {
  it("returns empty string when oracle is undefined", () => {
    expect(buildR011ComplianceNote(undefined)).toBe("");
  });

  it("returns not-applicable note when no causal language present", () => {
    const oracle = makeOracle({ analysis: "BTC held 77k. ETH tested 2300. Tight ranges across crypto.", assumptions: [] });
    const note = buildR011ComplianceNote(oracle);
    expect(note).toMatch(/not applicable|no causal/i);
  });

  it("returns COMPLIANT when causal language present AND assumptions populated", () => {
    const oracle = makeOracle({
      analysis: "BTC suggests underlying strength with infrastructure tokens leading.",
      assumptions: ["Infrastructure token outperformance suggests risk-on — unconfirmed from price data alone"],
    });
    const note = buildR011ComplianceNote(oracle);
    expect(note).toMatch(/COMPLIANT/);
    expect(note).toMatch(/Do NOT flag/i);
  });

  it("COMPLIANT note includes assumptions count", () => {
    const oracle = makeOracle({
      analysis: "NASDAQ indicates defensive rotation driven by DXY strength.",
      assumptions: ["DXY strength driving NASDAQ weakness — unconfirmed", "Defensive rotation inferred from cross-asset correlation"],
    });
    const note = buildR011ComplianceNote(oracle);
    expect(note).toMatch(/2 entr/);
  });

  it("returns VIOLATION when causal language present AND assumptions empty", () => {
    const oracle = makeOracle({
      analysis: "EUR/USD suggests bearish continuation driven by ECB policy.",
      assumptions: [],
    });
    const note = buildR011ComplianceNote(oracle);
    expect(note).toMatch(/VIOLATION/);
  });

  it("detects 'indicates' as causal language", () => {
    const oracle = makeOracle({ analysis: "This indicates a trend reversal.", assumptions: [] });
    expect(buildR011ComplianceNote(oracle)).toMatch(/VIOLATION/);
  });

  it("detects 'reflects' as causal language", () => {
    const oracle = makeOracle({ analysis: "The move reflects macro uncertainty.", assumptions: [] });
    expect(buildR011ComplianceNote(oracle)).toMatch(/VIOLATION/);
  });

  it("detects 'driven by' as causal language", () => {
    const oracle = makeOracle({ analysis: "Rally driven by risk-on sentiment.", assumptions: [] });
    expect(buildR011ComplianceNote(oracle)).toMatch(/VIOLATION/);
  });

  it("detects 'due to' as causal language", () => {
    const oracle = makeOracle({ analysis: "Weakness due to USD strength.", assumptions: [] });
    expect(buildR011ComplianceNote(oracle)).toMatch(/VIOLATION/);
  });
});

describe("parseAxiomResponse — r011 false-positive suppression", () => {
  const rules = makeRules();

  function makeAxiomJson(whatFailed: string, selfTasks: any[] = []): string {
    return JSON.stringify({
      whatWorked: "Good screening",
      whatFailed,
      cognitiveBiases: [],
      evolutionSummary: "Learned something",
      ruleUpdates: [],
      newRules: [],
      systemPromptAdditions: "",
      newSelfTasks: selfTasks,
      resolvedSelfTasks: [],
      codeChanges: [],
    });
  }

  it("strips r011 violation sentence from whatFailed when oracle.assumptions is populated", () => {
    const oracle = makeOracle({ assumptions: ["Iran tensions driving oil", "USD strength from safe haven"], analysis: "Oil suggests geopolitical catalyst." });
    const result = parseAxiomResponse(makeAxiomJson("Systematic r011 causal attribution violation persists."), 1, rules, oracle);
    expect(result.whatFailed).not.toMatch(/r011/i);
  });

  it("preserves non-r011 content in whatFailed after r011 suppression", () => {
    const oracle = makeOracle({ assumptions: ["Iran geopolitical attribution"], analysis: "This indicates a move." });
    const result = parseAxiomResponse(makeAxiomJson("r011 causal attribution failure. Also missed 4 setups in forex."), 1, rules, oracle);
    expect(result.whatFailed).not.toMatch(/r011/i);
    expect(result.whatFailed).toMatch(/4 setups/i);
  });

  it("does NOT suppress when oracle.assumptions is empty (genuine violation)", () => {
    const oracle = makeOracle({ assumptions: [], analysis: "Oil indicates geopolitical risk." });
    const result = parseAxiomResponse(makeAxiomJson("r011 causal attribution violation — assumptions array empty."), 1, rules, oracle);
    expect(result.whatFailed).toMatch(/r011/i);
  });

  it("does NOT suppress when oracle is undefined", () => {
    const result = parseAxiomResponse(makeAxiomJson("r011 causal attribution violation."), 1, rules, undefined);
    expect(result.whatFailed).toMatch(/r011/i);
  });

  it("does NOT modify whatFailed when r011 is not mentioned", () => {
    const oracle = makeOracle({ assumptions: ["some assumption"], analysis: "This suggests a move." });
    const result = parseAxiomResponse(makeAxiomJson("Missed EUR/USD setup. Confidence too low."), 1, rules, oracle);
    expect(result.whatFailed).toMatch(/EUR\/USD/);
  });

  it("suppresses r011 self-task when assumptions are populated", () => {
    const oracle = makeOracle({ assumptions: ["some attribution"], analysis: "This reflects risk sentiment." });
    const selfTask = { title: "Fix r011 causal attribution violations", body: "r011 keeps being violated", category: "rule-gap", priority: "high" };
    const result = parseAxiomResponse(makeAxiomJson("r011 violation detected.", [selfTask]), 1, rules, oracle);
    const hasr011Task = (result.newSelfTasks ?? []).some((t: any) => /r011|causal attribution/i.test(t.title ?? ""));
    expect(hasr011Task).toBe(false);
  });

  it("keeps non-r011 self-tasks when suppressing r011", () => {
    const oracle = makeOracle({ assumptions: ["some attribution"], analysis: "This suggests a move." });
    const tasks = [
      { title: "Fix r011 causal attribution", body: "r011 issue description", category: "rule-gap", priority: "high" },
      { title: "Improve setup coverage for forex", body: "forex coverage description", category: "rule-gap", priority: "medium" },
    ];
    const result = parseAxiomResponse(makeAxiomJson("r011 violation. Also forex coverage gap.", tasks), 1, rules, oracle);
    const hasr011Task = (result.newSelfTasks ?? []).some((t: any) => /r011/i.test(t.title ?? ""));
    const hasForexTask = (result.newSelfTasks ?? []).some((t: any) => /forex/i.test(t.title ?? ""));
    expect(hasr011Task).toBe(false);
    expect(hasForexTask).toBe(true);
  });
});
