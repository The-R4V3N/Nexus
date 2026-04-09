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

// ── resolveAllSetups instrument name normalization ────────────

describe("resolveAllSetups instrument normalization", () => {
  it("matches NAS100 setup against NASDAQ 100 snapshot", async () => {
    const { resolveAllSetups } = await import("../src/analytics");
    const entries: JournalEntry[] = [
      makeEntry(1, {
        setups: [makeSetup({ instrument: "NAS100", direction: "bullish", entry: 20000, stop: 19800, target: 20400 })],
        snapshots: [],
      }),
      makeEntry(2, {
        setups: [],
        snapshots: [{ symbol: "^NDX", name: "NASDAQ 100", price: 20500, previousClose: 20000, change: 500, changePercent: 2.5, high: 20600, low: 19900, timestamp: new Date(), category: "indices" }],
      }),
    ];
    const results = resolveAllSetups(entries);
    expect(results).toHaveLength(1);
    expect(results[0].outcome).toBe("TARGET_HIT");
  });

  it("matches BTC setup against Bitcoin snapshot", async () => {
    const { resolveAllSetups } = await import("../src/analytics");
    const entries: JournalEntry[] = [
      makeEntry(1, {
        setups: [makeSetup({ instrument: "BTC", direction: "bullish", entry: 70000, stop: 69000, target: 72000 })],
        snapshots: [],
      }),
      makeEntry(2, {
        setups: [],
        snapshots: [{ symbol: "BTC-USD", name: "Bitcoin", price: 68000, previousClose: 70000, change: -2000, changePercent: -2.9, high: 70100, low: 67500, timestamp: new Date(), category: "crypto" }],
      }),
    ];
    const results = resolveAllSetups(entries);
    expect(results).toHaveLength(1);
    expect(results[0].outcome).toBe("STOPPED_OUT");
  });

  it("matches ETH/USD setup against Ethereum snapshot", async () => {
    const { resolveAllSetups } = await import("../src/analytics");
    const entries: JournalEntry[] = [
      makeEntry(1, {
        setups: [makeSetup({ instrument: "ETH/USD", direction: "bullish", entry: 2000, stop: 1950, target: 2100 })],
        snapshots: [],
      }),
      makeEntry(2, {
        setups: [],
        snapshots: [{ symbol: "ETH-USD", name: "Ethereum", price: 2050, previousClose: 2000, change: 50, changePercent: 2.5, high: 2060, low: 1990, timestamp: new Date(), category: "crypto" }],
      }),
    ];
    const results = resolveAllSetups(entries);
    expect(results).toHaveLength(1);
    expect(results[0].outcome).toBe("OPEN");
  });
});

// ── resolveAllSetups multi-session resolution ─────────────────

describe("resolveAllSetups multi-session", () => {
  it("resolves TARGET_HIT at session N+2 when N+1 is open", async () => {
    const { resolveAllSetups } = await import("../src/analytics");
    const s1 = makeEntry(1, { setups: [makeSetup({ instrument: "EUR/USD", direction: "bullish", entry: 1.10, stop: 1.09, target: 1.12 })], snapshots: [] });
    const s2 = makeEntry(2, { setups: [], snapshots: [{ symbol: "EURUSD=X", name: "EUR/USD", price: 1.11, previousClose: 1.10, change: 0.01, changePercent: 0.9, high: 1.115, low: 1.095, timestamp: new Date(), category: "forex" }] });
    const s3 = makeEntry(3, { setups: [], snapshots: [{ symbol: "EURUSD=X", name: "EUR/USD", price: 1.13, previousClose: 1.11, change: 0.02, changePercent: 1.8, high: 1.135, low: 1.105, timestamp: new Date(), category: "forex" }] });
    const results = resolveAllSetups([s1, s2, s3]);
    expect(results[0].outcome).toBe("TARGET_HIT");
    expect(results[0].resolvedAtSession).toBe(2);
  });

  it("resolvedAtSession is 1 when resolved immediately at N+1", async () => {
    const { resolveAllSetups } = await import("../src/analytics");
    const s1 = makeEntry(1, { setups: [makeSetup({ instrument: "EUR/USD", direction: "bullish", entry: 1.10, stop: 1.09, target: 1.12 })], snapshots: [] });
    const s2 = makeEntry(2, { setups: [], snapshots: [{ symbol: "EURUSD=X", name: "EUR/USD", price: 1.13, previousClose: 1.10, change: 0.03, changePercent: 2.7, high: 1.135, low: 1.095, timestamp: new Date(), category: "forex" }] });
    const results = resolveAllSetups([s1, s2]);
    expect(results[0].outcome).toBe("TARGET_HIT");
    expect(results[0].resolvedAtSession).toBe(1);
  });

  it("respects windowSize and does not look past it", async () => {
    const { resolveAllSetups } = await import("../src/analytics");
    const snap = (price: number) => [{ symbol: "EURUSD=X", name: "EUR/USD", price, previousClose: price, change: 0, changePercent: 0, high: price, low: price, timestamp: new Date(), category: "forex" as const }];
    const s1 = makeEntry(1, { setups: [makeSetup({ instrument: "EUR/USD", direction: "bullish", entry: 1.10, stop: 1.09, target: 1.12 })], snapshots: [] });
    const s2 = makeEntry(2, { setups: [], snapshots: snap(1.11) });
    const s3 = makeEntry(3, { setups: [], snapshots: snap(1.13) }); // would be TARGET_HIT if checked
    const results = resolveAllSetups([s1, s2, s3], 1);
    expect(results[0].outcome).toBe("OPEN");
    expect(results[0].resolvedAtSession).toBeUndefined();
  });

  it("outcome is INCOMPLETE when no price data in any forward session", async () => {
    const { resolveAllSetups } = await import("../src/analytics");
    const s1 = makeEntry(1, { setups: [makeSetup({ instrument: "EXOTIC/PAIR", direction: "bullish", entry: 100, stop: 99, target: 102 })], snapshots: [] });
    const s2 = makeEntry(2, { setups: [], snapshots: [] });
    const s3 = makeEntry(3, { setups: [], snapshots: [] });
    const results = resolveAllSetups([s1, s2, s3]);
    expect(results[0].outcome).toBe("INCOMPLETE");
    expect(results[0].nextPrice).toBeNull();
    expect(results[0].resolvedAtSession).toBeUndefined();
  });

  it("STOPPED_OUT beats OPEN across two sessions — bearish stops when price rises", async () => {
    const { resolveAllSetups } = await import("../src/analytics");
    const snap = (price: number) => [{ symbol: "EURUSD=X", name: "EUR/USD", price, previousClose: price, change: 0, changePercent: 0, high: price, low: price, timestamp: new Date(), category: "forex" as const }];
    const s1 = makeEntry(1, { setups: [makeSetup({ instrument: "EUR/USD", direction: "bearish", entry: 1.10, stop: 1.12, target: 1.07 })], snapshots: [] });
    const s2 = makeEntry(2, { setups: [], snapshots: snap(1.11) }); // OPEN (below stop 1.12, above target 1.07)
    const s3 = makeEntry(3, { setups: [], snapshots: snap(1.13) }); // STOPPED_OUT (>= stop 1.12)
    const results = resolveAllSetups([s1, s2, s3]);
    expect(results[0].outcome).toBe("STOPPED_OUT");
    expect(results[0].resolvedAtSession).toBe(2);
  });
});
