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
    vi.resetModules();
    vi.doMock("../src/crypto-markets", () => ({
      fetchCryptoMarkets: async () => [],
    }));
    vi.doMock("../src/utils", async () => {
      const actual = await vi.importActual<any>("../src/utils");
      return { ...actual, isWeekend: () => true };
    });
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
      fetchRSSNews: async () => [],
      formatRSSForPrompt: () => "",
    }));

    const { fetchAllInputData } = await import("../src/agent");
    await expect(fetchAllInputData()).rejects.toThrow(/0 crypto instruments/i);
  });
});
