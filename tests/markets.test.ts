import { describe, it, expect } from "vitest";
import { formatSnapshotsForPrompt, MARKET_CONFIGS } from "../src/markets";
import type { MarketSnapshot } from "../src/types";

function makeSnapshot(overrides: Partial<MarketSnapshot> = {}): MarketSnapshot {
  return {
    symbol: "EURUSD=X",
    name: "EUR/USD",
    category: "forex",
    price: 1.08500,
    previousClose: 1.08000,
    change: 0.00500,
    changePercent: 0.46,
    high: 1.08700,
    low: 1.07900,
    avgDailyChange: 0.5,
    timestamp: new Date(),
    ...overrides,
  };
}

// ── MARKET_CONFIGS ──────────────────────────────────────────

describe("MARKET_CONFIGS", () => {
  it("contains 45 instruments", () => {
    expect(MARKET_CONFIGS).toHaveLength(45);
  });

  it("covers all expected categories", () => {
    const categories = new Set(MARKET_CONFIGS.map((c) => c.category));
    expect(categories).toEqual(new Set(["forex", "indices", "crypto", "commodities"]));
  });

  it("has unique symbols", () => {
    const symbols = MARKET_CONFIGS.map((c) => c.symbol);
    expect(new Set(symbols).size).toBe(symbols.length);
  });

  it("has non-empty names", () => {
    for (const config of MARKET_CONFIGS) {
      expect(config.name.length).toBeGreaterThan(0);
    }
  });
});

// ── formatSnapshotsForPrompt ────────────────────────────────

describe("formatSnapshotsForPrompt", () => {
  it("returns header for empty snapshots", () => {
    const result = formatSnapshotsForPrompt([]);
    expect(result).toContain("=== CURRENT MARKET DATA ===");
  });

  it("groups snapshots by category", () => {
    const snapshots = [
      makeSnapshot({ name: "EUR/USD", category: "forex" }),
      makeSnapshot({ name: "Gold", category: "commodities", symbol: "GC=F", price: 2050.00 }),
      makeSnapshot({ name: "GBP/USD", category: "forex", symbol: "GBPUSD=X" }),
    ];
    const result = formatSnapshotsForPrompt(snapshots);
    expect(result).toContain("--- FOREX ---");
    expect(result).toContain("--- COMMODITIES ---");
    expect(result).toContain("EUR/USD");
    expect(result).toContain("GBP/USD");
    expect(result).toContain("Gold");
  });

  it("formats price with 5 decimals for prices < 10", () => {
    const snapshots = [makeSnapshot({ price: 1.08500 })];
    const result = formatSnapshotsForPrompt(snapshots);
    expect(result).toContain("1.08500");
  });

  it("formats price with 2 decimals for prices >= 10", () => {
    const snapshots = [
      makeSnapshot({ name: "Gold", category: "commodities", symbol: "GC=F", price: 2050.75 }),
    ];
    const result = formatSnapshotsForPrompt(snapshots);
    expect(result).toContain("2050.75");
  });

  it("shows + sign for positive change", () => {
    const snapshots = [makeSnapshot({ change: 0.005, changePercent: 0.46 })];
    const result = formatSnapshotsForPrompt(snapshots);
    expect(result).toContain("+");
  });

  it("shows negative change without + sign", () => {
    const snapshots = [makeSnapshot({ change: -0.005, changePercent: -0.46 })];
    const result = formatSnapshotsForPrompt(snapshots);
    expect(result).toContain("-0.46%");
  });

  it("includes high and low values", () => {
    const snapshots = [makeSnapshot({ high: 1.09000, low: 1.07500 })];
    const result = formatSnapshotsForPrompt(snapshots);
    expect(result).toContain("H:1.09");
    expect(result).toContain("L:1.07");
  });

  it("shows [>2x avg move] when change exceeds 2x average daily change", () => {
    const snapshots = [makeSnapshot({ changePercent: 2.5, avgDailyChange: 0.5 })];
    const result = formatSnapshotsForPrompt(snapshots);
    expect(result).toContain("[>2x avg move]");
  });

  it("does not show [>2x avg move] when change is within normal range", () => {
    const snapshots = [makeSnapshot({ changePercent: 0.46, avgDailyChange: 0.5 })];
    const result = formatSnapshotsForPrompt(snapshots);
    expect(result).not.toContain("[>2x avg move]");
  });

  it("does not show [>2x avg move] when avgDailyChange is undefined", () => {
    const snapshots = [makeSnapshot({ changePercent: 5.0, avgDailyChange: undefined })];
    const result = formatSnapshotsForPrompt(snapshots);
    expect(result).not.toContain("[>2x avg move]");
  });
});
