import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock fs and journal before importing analytics
vi.mock("fs");
vi.mock("../src/journal", () => ({
  loadAllJournalEntries: vi.fn(() => []),
}));

import { runAnalytics } from "../src/analytics";
import { loadAllJournalEntries } from "../src/journal";
import * as fs from "fs";
import type { JournalEntry, OracleAnalysis, AxiomReflection } from "../src/types";

// ── Helpers ─────────────────────────────────────────────────

function makeSetup(overrides: Record<string, any> = {}) {
  return {
    instrument: "EUR/USD",
    type: "FVG" as const,
    direction: "bullish" as const,
    description: "test",
    invalidation: "test",
    entry: 1.1000,
    stop: 1.0900,
    target: 1.1200,
    RR: 2.0,
    ...overrides,
  };
}

function makeEntry(sessionNumber: number, overrides: Record<string, any> = {}): JournalEntry {
  const conf = overrides.confidence ?? 50;
  const setups = overrides.setups ?? [];
  const bias = overrides.bias ?? "mixed";
  const snapshots = overrides.snapshots ?? [];
  const ruleUpdates = overrides.ruleUpdates ?? [];

  return {
    sessionNumber,
    date: `2026-03-${String(sessionNumber).padStart(2, "0")} 12:00`,
    title: `Session ${sessionNumber}`,
    oracleSummary: `Summary ${sessionNumber}`,
    axiomSummary: `Reflection ${sessionNumber}`,
    fullAnalysis: {
      timestamp: new Date(),
      sessionId: `nx-${sessionNumber}`,
      marketSnapshots: snapshots,
      analysis: "Test analysis text that is long enough",
      setups,
      bias: { overall: bias, notes: "test" },
      keyLevels: [],
      confidence: conf,
    } as OracleAnalysis,
    reflection: {
      timestamp: new Date(),
      sessionId: `nx-${sessionNumber}`,
      whatWorked: "test",
      whatFailed: "test",
      cognitiveBiases: overrides.cognitiveBiases ?? [],
      ruleUpdates,
      newSystemPromptSections: "",
      evolutionSummary: "test",
    } as AxiomReflection,
    ruleCount: overrides.ruleCount ?? 10,
    systemPromptVersion: overrides.systemPromptVersion ?? 1,
  };
}

function makeSnapshot(name: string, price: number) {
  return {
    symbol: `${name}=X`,
    name,
    category: "forex" as const,
    price,
    previousClose: price,
    change: 0,
    changePercent: 0,
    high: price,
    low: price,
    timestamp: new Date(),
  };
}

// ── Tests ───────────────────────────────────────────────────

describe("analytics", () => {
  beforeEach(() => {
    vi.mocked(loadAllJournalEntries).mockReturnValue([]);
    vi.mocked(fs.existsSync).mockReturnValue(false);
  });

  it("handles empty session history gracefully", () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    runAnalytics({});
    expect(spy).toHaveBeenCalled();
    const output = spy.mock.calls.map(c => c[0]).join("\n");
    expect(output).toContain("No sessions yet");
    spy.mockRestore();
  });

  it("resolves TARGET_HIT for bullish setup where next price >= target", () => {
    const entries = [
      makeEntry(1, {
        setups: [makeSetup({ instrument: "EUR/USD", direction: "bullish", entry: 1.10, stop: 1.09, target: 1.12 })],
      }),
      makeEntry(2, {
        snapshots: [makeSnapshot("EUR/USD", 1.13)], // above target
      }),
    ];
    vi.mocked(loadAllJournalEntries).mockReturnValue(entries);

    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    runAnalytics({});
    const output = spy.mock.calls.map(c => c[0]).join("\n");
    expect(output).toContain("1 hits");
    expect(output).toContain("0 stops");
    spy.mockRestore();
  });

  it("resolves STOPPED_OUT for bullish setup where next price <= stop", () => {
    const entries = [
      makeEntry(1, {
        setups: [makeSetup({ instrument: "EUR/USD", direction: "bullish", entry: 1.10, stop: 1.09, target: 1.12 })],
      }),
      makeEntry(2, {
        snapshots: [makeSnapshot("EUR/USD", 1.08)], // below stop
      }),
    ];
    vi.mocked(loadAllJournalEntries).mockReturnValue(entries);

    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    runAnalytics({});
    const output = spy.mock.calls.map(c => c[0]).join("\n");
    expect(output).toContain("0 hits");
    expect(output).toContain("1 stops");
    spy.mockRestore();
  });

  it("resolves STOPPED_OUT for bearish setup where next price >= stop", () => {
    const entries = [
      makeEntry(1, {
        setups: [makeSetup({ instrument: "EUR/USD", direction: "bearish", entry: 1.10, stop: 1.12, target: 1.08 })],
      }),
      makeEntry(2, {
        snapshots: [makeSnapshot("EUR/USD", 1.13)], // above stop
      }),
    ];
    vi.mocked(loadAllJournalEntries).mockReturnValue(entries);

    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    runAnalytics({});
    const output = spy.mock.calls.map(c => c[0]).join("\n");
    expect(output).toContain("0 hits");
    expect(output).toContain("1 stops");
    spy.mockRestore();
  });

  it("resolves TARGET_HIT for bearish setup where next price <= target", () => {
    const entries = [
      makeEntry(1, {
        setups: [makeSetup({ instrument: "EUR/USD", direction: "bearish", entry: 1.10, stop: 1.12, target: 1.08 })],
      }),
      makeEntry(2, {
        snapshots: [makeSnapshot("EUR/USD", 1.07)], // below target
      }),
    ];
    vi.mocked(loadAllJournalEntries).mockReturnValue(entries);

    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    runAnalytics({});
    const output = spy.mock.calls.map(c => c[0]).join("\n");
    expect(output).toContain("1 hits");
    expect(output).toContain("0 stops");
    spy.mockRestore();
  });

  it("marks setups OPEN when price is between entry and target", () => {
    const entries = [
      makeEntry(1, {
        setups: [makeSetup({ instrument: "EUR/USD", direction: "bullish", entry: 1.10, stop: 1.09, target: 1.12 })],
      }),
      makeEntry(2, {
        snapshots: [makeSnapshot("EUR/USD", 1.11)], // between entry and target
      }),
    ];
    vi.mocked(loadAllJournalEntries).mockReturnValue(entries);

    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    runAnalytics({});
    const output = spy.mock.calls.map(c => c[0]).join("\n");
    expect(output).toContain("1 open");
    expect(output).toContain("0 hits");
    expect(output).toContain("0 stops");
    spy.mockRestore();
  });

  it("skips setups with missing entry/stop/target", () => {
    const entries = [
      makeEntry(1, {
        setups: [makeSetup({ instrument: "EUR/USD", entry: null, stop: null, target: null })],
      }),
      makeEntry(2, {
        snapshots: [makeSnapshot("EUR/USD", 1.11)],
      }),
    ];
    vi.mocked(loadAllJournalEntries).mockReturnValue(entries);

    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    runAnalytics({});
    const output = spy.mock.calls.map(c => c[0]).join("\n");
    expect(output).toContain("Setups: 0");
    spy.mockRestore();
  });

  it("shows improvement trend when enough sessions exist", () => {
    // 12 sessions: first 6 all stopped out, last 6 all target hit
    const entries: JournalEntry[] = [];
    for (let i = 1; i <= 12; i++) {
      const isFirstHalf = i <= 6;
      entries.push(makeEntry(i, {
        setups: isFirstHalf
          ? [makeSetup({ instrument: "EUR/USD", direction: "bullish", entry: 1.10, stop: 1.09, target: 1.12 })]
          : [makeSetup({ instrument: "EUR/USD", direction: "bullish", entry: 1.10, stop: 1.09, target: 1.12 })],
        snapshots: i > 1
          ? [makeSnapshot("EUR/USD", isFirstHalf ? 1.08 : 1.13)] // stopped vs target hit
          : [],
        confidence: isFirstHalf ? 40 : 70,
      }));
    }
    vi.mocked(loadAllJournalEntries).mockReturnValue(entries);

    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    runAnalytics({});
    const output = spy.mock.calls.map(c => c[0]).join("\n");
    expect(output).toContain("IMPROVEMENT TREND");
    expect(output).toContain("IMPROVING");
    spy.mockRestore();
  });

  it("counts rule evolution correctly", () => {
    const entries = [
      makeEntry(1, { ruleUpdates: [{ ruleId: "r001", type: "modify", reason: "test" }] }),
      makeEntry(2, { ruleUpdates: [] }),
      makeEntry(3, { ruleUpdates: [
        { ruleId: "r002", type: "add", reason: "test" },
        { ruleId: "r003", type: "modify", reason: "test" },
      ]}),
    ];
    vi.mocked(loadAllJournalEntries).mockReturnValue(entries);

    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    runAnalytics({});
    const output = spy.mock.calls.map(c => c[0]).join("\n");
    expect(output).toContain("Total changes: 3");
    spy.mockRestore();
  });

  it("tracks cognitive biases across sessions", () => {
    const entries = [
      makeEntry(1, { cognitiveBiases: ["anchoring bias", "confirmation bias"] }),
      makeEntry(2, { cognitiveBiases: ["anchoring bias"] }),
    ];
    vi.mocked(loadAllJournalEntries).mockReturnValue(entries);

    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    runAnalytics({});
    const output = spy.mock.calls.map(c => c[0]).join("\n");
    expect(output).toContain("2x anchoring bias");
    expect(output).toContain("1x confirmation bias");
    spy.mockRestore();
  });

  it("respects --window option", () => {
    const entries: JournalEntry[] = [];
    for (let i = 1; i <= 20; i++) {
      entries.push(makeEntry(i, { confidence: 50 + i }));
    }
    vi.mocked(loadAllJournalEntries).mockReturnValue(entries);

    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    runAnalytics({ window: "5" });
    const output = spy.mock.calls.map(c => c[0]).join("\n");
    expect(output).toContain("LAST 5 SESSIONS");
    spy.mockRestore();
  });
});
