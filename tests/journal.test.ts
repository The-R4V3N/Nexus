import { describe, it, expect } from "vitest";
import { buildJournalEntry } from "../src/journal";
import type { OracleAnalysis, AxiomReflection, AnalysisRules } from "../src/types";

function makeOracle(overrides: Partial<OracleAnalysis> = {}): OracleAnalysis {
  return {
    timestamp: new Date(),
    sessionId: "test-session",
    marketSnapshots: [],
    analysis: "Detailed market analysis text",
    setups: [
      {
        instrument: "Gold", type: "FVG", direction: "bullish",
        description: "FVG fill", invalidation: "break below 1900",
        entry: 2000, stop: 1950, target: 2100, RR: 2, timeframe: "1H",
      },
    ],
    bias: { overall: "bullish", notes: "Strong uptrend" },
    keyLevels: [],
    confidence: 72,
    ...overrides,
  };
}

function makeReflection(overrides: Partial<AxiomReflection> = {}): AxiomReflection {
  return {
    timestamp: new Date(),
    sessionId: "test-session",
    whatWorked: "Good structure",
    whatFailed: "Missed DXY correlation",
    cognitiveBiases: ["recency bias"],
    ruleUpdates: [],
    newSystemPromptSections: "",
    evolutionSummary: "Improved correlation analysis",
    ...overrides,
  };
}

function makeRules(overrides: Partial<AnalysisRules> = {}): AnalysisRules {
  return {
    version: 5,
    lastUpdated: "2024-01-01",
    rules: Array.from({ length: 12 }, (_, i) => ({
      id: `r${String(i + 1).padStart(3, "0")}`,
      category: "structure",
      description: `Rule ${i + 1}`,
      weight: 5,
      addedSession: 0,
      lastModifiedSession: 0,
    })),
    focusInstruments: ["Gold", "EUR/USD"],
    sessionNotes: "",
    ...overrides,
  };
}

// ── buildJournalEntry ───────────────────────────────────────

describe("buildJournalEntry", () => {
  it("builds a complete journal entry", () => {
    const entry = buildJournalEntry(7, makeOracle(), makeReflection(), makeRules());
    expect(entry.sessionNumber).toBe(7);
    expect(entry.ruleCount).toBe(12);
    expect(entry.systemPromptVersion).toBe(5);
    expect(entry.fullAnalysis.confidence).toBe(72);
    expect(entry.reflection.evolutionSummary).toBe("Improved correlation analysis");
  });

  it("generates oracleSummary with bias and setup count", () => {
    const entry = buildJournalEntry(1, makeOracle(), makeReflection(), makeRules());
    expect(entry.oracleSummary).toContain("BULLISH");
    expect(entry.oracleSummary).toContain("1 setups");
    expect(entry.oracleSummary).toContain("72/100");
    expect(entry.oracleSummary).toContain("Gold FVG (bullish)");
  });

  it("handles no setups gracefully", () => {
    const entry = buildJournalEntry(
      1,
      makeOracle({ setups: [] }),
      makeReflection(),
      makeRules()
    );
    expect(entry.oracleSummary).toContain("No high-probability setups");
  });

  it("generates a title with top setup instrument", () => {
    const entry = buildJournalEntry(1, makeOracle(), makeReflection(), makeRules());
    expect(entry.title).toContain("Gold");
    expect(entry.title).toContain("FVG");
  });

  it("title includes 'rule evolution' when rule updates exist", () => {
    const entry = buildJournalEntry(
      1,
      makeOracle(),
      makeReflection({
        ruleUpdates: [{ ruleId: "r001", type: "modify", after: "new", reason: "test" }],
      }),
      makeRules()
    );
    expect(entry.title).toContain("rule evolution");
  });

  it("title includes 'no rule changes' when no updates", () => {
    const entry = buildJournalEntry(
      1,
      makeOracle(),
      makeReflection({ ruleUpdates: [] }),
      makeRules()
    );
    expect(entry.title).toContain("no rule changes");
  });

  it("includes date in entry", () => {
    const entry = buildJournalEntry(1, makeOracle(), makeReflection(), makeRules());
    // date format: yyyy-MM-dd HH:mm
    expect(entry.date).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/);
  });

  it("uses axiom evolutionSummary as axiomSummary", () => {
    const entry = buildJournalEntry(
      1,
      makeOracle(),
      makeReflection({ evolutionSummary: "Big changes this session" }),
      makeRules()
    );
    expect(entry.axiomSummary).toBe("Big changes this session");
  });
});
