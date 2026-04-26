import { describe, it, expect, vi, beforeEach } from "vitest";
import type { JournalEntry } from "../src/types";

// Helper to create a minimal JournalEntry with a specific whatFailed
function makeEntry(whatFailed: string, sessionNumber = 1): JournalEntry {
  return {
    sessionNumber,
    date: "2025-01-01",
    title: "Test Session",
    oracleSummary: "summary",
    axiomSummary: "axiom summary",
    fullAnalysis: {
      timestamp: new Date(),
      sessionId: "nx-test",
      marketSnapshots: [],
      analysis: "test",
      setups: [],
      bias: { overall: "neutral", notes: "" },
      keyLevels: [],
      confidence: 50,
    },
    reflection: {
      timestamp: new Date(),
      sessionId: "nx-test",
      whatWorked: "good stuff",
      whatFailed,
      cognitiveBiases: [],
      ruleUpdates: [],
      newSystemPromptSections: "",
      evolutionSummary: "evolved",
    },
    ruleCount: 10,
    systemPromptVersion: 1,
  };
}

// ── detectRepeatedCritiques ─────────────────────────────────

describe("detectRepeatedCritiques", () => {
  it("returns empty critique when fewer than 3 entries", async () => {
    const { detectRepeatedCritiques } = await import("../src/agent");
    const entries = [
      makeEntry("Some critique about missing setups", 1),
      makeEntry("Some critique about missing setups", 2),
    ];
    const result = detectRepeatedCritiques(entries);
    expect(result.critique).toBe("");
    expect(result.count).toBe(0);
  });

  it("returns empty critique when critiques are all different", async () => {
    const { detectRepeatedCritiques } = await import("../src/agent");
    const entries = [
      makeEntry("The analysis lacked proper entry levels for forex pairs", 1),
      makeEntry("Bitcoin correlation analysis was completely absent from the review", 2),
      makeEntry("Gold risk-off signals were ignored during the session analysis", 3),
    ];
    expect(detectRepeatedCritiques(entries).critique).toBe("");
  });

  it("returns the repeated phrase and count when entries share similar critique", async () => {
    const { detectRepeatedCritiques } = await import("../src/agent");
    const sharedCritique = "The analysis failed to include proper entry and stop levels for identified setups";
    const entries = [
      makeEntry(sharedCritique + ". Also some unique content for session one.", 1),
      makeEntry(sharedCritique + ". Different unique content for session two here.", 2),
      makeEntry(sharedCritique + ". Yet another unique observation for session three.", 3),
    ];
    const result = detectRepeatedCritiques(entries);
    expect(result.critique.length).toBeGreaterThan(0);
    expect(result.count).toBeGreaterThanOrEqual(3);
  });

  it("returns empty critique when only 2 of 3 entries share the critique", async () => {
    const { detectRepeatedCritiques } = await import("../src/agent");
    const sharedCritique = "The analysis failed to include proper entry and stop levels for identified setups";
    const entries = [
      makeEntry(sharedCritique + ". Some unique content here.", 1),
      makeEntry("A completely different critique about macro analysis being weak and unfocused", 2),
      makeEntry(sharedCritique + ". More unique content here.", 3),
    ];
    expect(detectRepeatedCritiques(entries).critique).toBe("");
  });

  it("returns empty critique when one critique is empty", async () => {
    const { detectRepeatedCritiques } = await import("../src/agent");
    const entries = [
      makeEntry("Some critique", 1),
      makeEntry("", 2),
      makeEntry("Some critique", 3),
    ];
    expect(detectRepeatedCritiques(entries).critique).toBe("");
  });
});

// ── isWeekend helper ──────────────────────────────────────────

describe("isWeekend", () => {
  it("is exported from agent", async () => {
    const mod = await import("../src/agent");
    expect(typeof mod.isWeekend).toBe("function");
  });

  it("returns true on Saturday (day 6)", async () => {
    const mod = await import("../src/agent");
    const saturday = new Date("2026-03-21T12:00:00Z"); // Saturday
    expect(mod.isWeekend(saturday)).toBe(true);
  });

  it("returns true on Sunday (day 0)", async () => {
    const mod = await import("../src/agent");
    const sunday = new Date("2026-03-22T12:00:00Z"); // Sunday
    expect(mod.isWeekend(sunday)).toBe(true);
  });

  it("returns false on weekdays", async () => {
    const mod = await import("../src/agent");
    const monday = new Date("2026-03-23T12:00:00Z"); // Monday
    expect(mod.isWeekend(monday)).toBe(false);
    const friday = new Date("2026-03-27T12:00:00Z"); // Friday
    expect(mod.isWeekend(friday)).toBe(false);
  });

  it("uses current date when no argument provided", async () => {
    const mod = await import("../src/agent");
    const result = mod.isWeekend();
    expect(typeof result).toBe("boolean");
  });
});

// We test the exported phase functions from agent.ts
// Note: fetchAllInputData and runAndValidateOracle require network/API calls,
// so we focus on writeSessionOutput structure and the exports existing.

describe("agent phase function exports", () => {
  it("exports fetchAllInputData", async () => {
    const mod = await import("../src/agent");
    expect(typeof mod.fetchAllInputData).toBe("function");
  });

  it("exports runAndValidateOracle", async () => {
    const mod = await import("../src/agent");
    expect(typeof mod.runAndValidateOracle).toBe("function");
  });

  it("exports runAndValidateAxiom", async () => {
    const mod = await import("../src/agent");
    expect(typeof mod.runAndValidateAxiom).toBe("function");
  });

  it("exports runAndValidateForge", async () => {
    const mod = await import("../src/agent");
    expect(typeof mod.runAndValidateForge).toBe("function");
  });

  it("exports writeSessionOutput", async () => {
    const mod = await import("../src/agent");
    expect(typeof mod.writeSessionOutput).toBe("function");
  });

  it("exports runSession", async () => {
    const mod = await import("../src/agent");
    expect(typeof mod.runSession).toBe("function");
  });
});

// ── fetchAllInputData — weekend Binance failure ─────────────

describe("fetchAllInputData — weekend Binance failure", () => {
  afterEach(() => {
    vi.resetModules();
  });

  it("throws when fetchCryptoMarkets returns 0 instruments on weekend", async () => {
    // Force a Sunday so isWeekend() returns true regardless of when CI runs
    // (isWeekend is defined in agent.ts and uses new Date() internally)
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-05T10:00:00Z")); // Sunday

    vi.resetModules();
    vi.doMock("../src/crypto-markets", () => ({
      fetchCryptoMarkets: async () => [],
    }));
    vi.doMock("../src/issues", () => ({
      fetchCommunityIssues: async () => [],
      formatIssuesForPrompt: () => "",
      sanitizeAllIssues: (x: any) => x,
    }));
    vi.doMock("../src/self-tasks", () => ({
      fetchOpenSelfTasks: async () => [],
      formatSelfTasksForPrompt: () => "",
      setCachedOpenTasks: () => {},
    }));
    vi.doMock("../src/rss", () => ({
      fetchRSSNews: async () => ({ articles: [], errors: [] }),
      formatRSSForPrompt: () => "",
    }));

    const { fetchAllInputData } = await import("../src/agent");
    await expect(fetchAllInputData()).rejects.toThrow(/0 crypto instruments/i);

    vi.useRealTimers();
  });
});

// ── formatComplianceReport ────────────────────────────────────

describe("formatComplianceReport", () => {
  it("is exported from agent", async () => {
    const mod = await import("../src/agent");
    expect(typeof (mod as any).formatComplianceReport).toBe("function");
  });

  it("returns empty string when no warnings", async () => {
    const { formatComplianceReport } = await import("../src/agent") as any;
    expect(formatComplianceReport([])).toBe("");
  });

  it("formats single warning into compliance report", async () => {
    const { formatComplianceReport } = await import("../src/agent") as any;
    const result = formatComplianceReport(["r011 compliance: assumptions[] empty despite causal language"]);
    expect(result).toContain("ORACLE Compliance Report");
    expect(result).toContain("r011 compliance");
  });

  it("formats multiple warnings into compliance report", async () => {
    const { formatComplianceReport } = await import("../src/agent") as any;
    const warnings = [
      "r011 compliance: assumptions[] empty despite causal language",
      "Confidence mismatch: text says 67% but JSON says 35%",
    ];
    const result = formatComplianceReport(warnings);
    expect(result).toContain("r011 compliance");
    expect(result).toContain("Confidence mismatch");
    expect(result).toContain("3+ sessions in a row");
  });
});

// ── computeNoChangeStreak ─────────────────────────────────

function makeStreakEntry(opts: {
  ruleUpdates?: number;
  resolvedSelfTaskCount?: number;
  codeChangeCount?: number;
  sessionNumber?: number;
} = {}): JournalEntry {
  return {
    sessionNumber: opts.sessionNumber ?? 1,
    date: "2026-04-26",
    title: "Test session",
    oracleSummary: "Test summary",
    axiomSummary: "Test axiom",
    ruleCount: 44,
    systemPromptVersion: 110,
    fullAnalysis: {
      timestamp: new Date(),
      sessionId: "test-1",
      analysis: "Test analysis",
      bias: { overall: "neutral", notes: "" },
      confidence: 50,
      setups: [],
      keyLevels: [],
    },
    reflection: {
      timestamp: new Date(),
      sessionId: "test-1",
      whatWorked: "Test",
      whatFailed: "Test",
      cognitiveBiases: [],
      ruleUpdates: Array(opts.ruleUpdates ?? 0).fill({ ruleId: "r001", type: "modify", reason: "test" }),
      newSystemPromptSections: "",
      evolutionSummary: "Test",
      resolvedSelfTaskCount: opts.resolvedSelfTaskCount ?? 0,
      codeChangeCount: opts.codeChangeCount ?? 0,
    },
  } as any;
}

describe("computeNoChangeStreak", () => {
  it("returns 0 for empty entries", async () => {
    const { computeNoChangeStreak } = await import("../src/agent");
    expect(computeNoChangeStreak([])).toBe(0);
  });

  it("returns 0 when latest entry has rule updates", async () => {
    const { computeNoChangeStreak } = await import("../src/agent");
    const entries = [makeStreakEntry({ ruleUpdates: 0 }), makeStreakEntry({ ruleUpdates: 2 })];
    expect(computeNoChangeStreak(entries)).toBe(0);
  });

  it("counts consecutive zero-action sessions from most recent", async () => {
    const { computeNoChangeStreak } = await import("../src/agent");
    const entries = [
      makeStreakEntry({ ruleUpdates: 1 }),
      makeStreakEntry({ ruleUpdates: 0 }),
      makeStreakEntry({ ruleUpdates: 0 }),
      makeStreakEntry({ ruleUpdates: 0 }),
    ];
    expect(computeNoChangeStreak(entries)).toBe(3);
  });

  it("resets streak when latest entry has resolvedSelfTaskCount > 0", async () => {
    const { computeNoChangeStreak } = await import("../src/agent");
    const entries = [
      makeStreakEntry({ ruleUpdates: 0 }),
      makeStreakEntry({ ruleUpdates: 0 }),
      makeStreakEntry({ ruleUpdates: 0, resolvedSelfTaskCount: 1 }),
    ];
    expect(computeNoChangeStreak(entries)).toBe(0);
  });

  it("resets streak when latest entry has codeChangeCount > 0", async () => {
    const { computeNoChangeStreak } = await import("../src/agent");
    const entries = [
      makeStreakEntry({ ruleUpdates: 0 }),
      makeStreakEntry({ ruleUpdates: 0 }),
      makeStreakEntry({ ruleUpdates: 0, codeChangeCount: 1 }),
    ];
    expect(computeNoChangeStreak(entries)).toBe(0);
  });

  it("AXIOM parse failure (empty ruleUpdates, no tasks/code) counts toward streak", async () => {
    const { computeNoChangeStreak } = await import("../src/agent");
    const failEntry = makeStreakEntry({ ruleUpdates: 0, resolvedSelfTaskCount: 0, codeChangeCount: 0 });
    (failEntry.reflection as any).whatWorked = "Unable to parse reflection";
    const entries = [
      makeStreakEntry({ ruleUpdates: 1 }),
      failEntry,
      makeStreakEntry({ ruleUpdates: 0 }),
    ];
    expect(computeNoChangeStreak(entries)).toBe(2);
  });

  it("returns 1 when only last entry has no action", async () => {
    const { computeNoChangeStreak } = await import("../src/agent");
    const entries = [makeStreakEntry({ ruleUpdates: 2 }), makeStreakEntry({ ruleUpdates: 0 })];
    expect(computeNoChangeStreak(entries)).toBe(1);
  });
});
