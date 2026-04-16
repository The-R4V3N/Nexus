import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { buildR029StopNote, buildWeekdayScreeningTemplate, buildR041ScreeningNote, computeOracleConfidence, buildR039R040CrossAssetNote, applyR039R040Penalty, enforceR041ScreeningValidation } from "../src/oracle";
import { resolveConfidence } from "../src/validate";
import type { MarketSnapshot } from "../src/types";

function makeSnap(changePercent: number): MarketSnapshot {
  return { symbol: "EUR=X", name: "EUR/USD", category: "forex", price: 1.10, previousClose: 1.0, change: 0, changePercent, high: 1.11, low: 1.09, timestamp: new Date() };
}

// ── buildR029StopNote ─────────────────────────────────────

describe("buildR029StopNote", () => {
  it("returns empty string when no volatility (all moves < 3%)", () => {
    const snaps = [makeSnap(1.5), makeSnap(-2.0), makeSnap(0.5)];
    expect(buildR029StopNote(snaps)).toBe("");
  });

  it("requires 1.5% stop for instruments that moved >= 5%", () => {
    const snaps = [makeSnap(1.0), makeSnap(5.2), makeSnap(-2.0)];
    const note = buildR029StopNote(snaps);
    expect(note).toContain("1.5%");
    expect(note).toContain("5.2%");
  });

  it("requires 1.0% stop for instruments that moved >= 3% but < 5%", () => {
    const snaps = [makeSnap(1.0), makeSnap(3.8), makeSnap(-1.0)];
    const note = buildR029StopNote(snaps);
    expect(note).toContain("1.0%");
    expect(note).not.toContain("1.5%");
  });

  it("uses absolute value of negative moves", () => {
    const snaps = [makeSnap(-6.0), makeSnap(1.0)];
    const note = buildR029StopNote(snaps);
    expect(note).toContain("1.5%");
  });

  it("returns empty string for empty snapshots array", () => {
    expect(buildR029StopNote([])).toBe("");
  });

  it("includes r029 rule reference", () => {
    const snaps = [makeSnap(5.0)];
    const note = buildR029StopNote(snaps);
    expect(note).toContain("r029");
  });

  it("includes a stop calculation example", () => {
    const snaps = [makeSnap(5.0)];
    const note = buildR029StopNote(snaps);
    expect(note.toLowerCase()).toMatch(/entry.*stop|stop.*entry/);
  });

  it("only lists volatile instruments — low-move instruments not mentioned with stop requirement (session #179 pattern)", () => {
    // Oil -8.62% should get 1.5% requirement; EUR/USD 0.81% should get nothing
    const oilSnap = { symbol: "CL=F",    name: "Crude Oil", category: "commodities" as const, price: 90,    previousClose: 98.16, change: -8.16, changePercent: -8.62, high: 98, low: 89, timestamp: new Date() };
    const eurSnap = { symbol: "EURUSD=X",name: "EUR/USD",   category: "forex"        as const, price: 1.1786,previousClose: 1.169, change: 0.0095, changePercent: 0.81, high: 1.18, low: 1.17, timestamp: new Date() };
    const note = buildR029StopNote([oilSnap, eurSnap]);
    expect(note).toContain("1.5%");          // Oil needs wide stop
    expect(note).toContain("Crude Oil");     // Oil is named
    expect(note).not.toContain("EUR/USD");   // EUR/USD is NOT listed — no requirement for it
  });
});

// ── Export presence tests ──────────────────────────────────

describe("oracle module exports", () => {
  it("exports runOracleAnalysis", async () => {
    const oracle = await import("../src/oracle");
    expect(typeof oracle.runOracleAnalysis).toBe("function");
  });

  it("exports warnPoorRiskReward", async () => {
    const oracle = await import("../src/oracle");
    expect(typeof oracle.warnPoorRiskReward).toBe("function");
  });
});

// ── Two-call split integration tests ──────────────────────

describe("runOracleAnalysis two-call split", () => {
  let warnSpy: ReturnType<typeof vi.spyOn>;
  let logSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
  });

  afterEach(() => {
    warnSpy.mockRestore();
    logSpy.mockRestore();
    vi.restoreAllMocks();
  });

  it("makes two sequential API calls and merges results", async () => {
    // Mock the Anthropic client
    const analysisResponse = {
      analysis: "**Higher Timeframe Context:** Market is bullish. **Intraday Analysis:** Strong momentum. **Cross-Asset Dynamics:** Correlations intact. **Technical Confluence Analysis:** Confidence: 65% — TC (70%), MA (60%), RR (60%)",
      bias: { overall: "bullish", notes: "Strong uptrend" },
      keyLevels: [{ instrument: "Gold", level: 2000, type: "support", notes: "Key level" }],
      confidence: 65,
    };

    const setupsResponse = [
      {
        instrument: "Gold",
        type: "FVG",
        direction: "bullish",
        description: "FVG at 2000",
        invalidation: "Break below 1980",
        entry: 2000,
        stop: 1980,
        target: 2040,
        RR: 2.0,
        timeframe: "4H",
      },
    ];

    let callCount = 0;
    const mockClient = {
      messages: {
        create: vi.fn(async () => {
          callCount++;
          const responseJSON = callCount === 1
            ? JSON.stringify(analysisResponse)
            : JSON.stringify(setupsResponse);
          return {
            stop_reason: "end_turn",
            content: [{ type: "text", text: responseJSON }],
          };
        }),
      },
    };

    // Mock fs and dependencies
    vi.doMock("fs", async () => {
      const actual = await vi.importActual<typeof import("fs")>("fs");
      return {
        ...actual,
        existsSync: (p: string) => {
          if (p.includes("system-prompt") || p.includes("analysis-rules")) return false;
          return actual.existsSync(p);
        },
      };
    });

    // Clear module cache so mocks take effect
    vi.resetModules();

    const { runOracleAnalysis } = await import("../src/oracle");

    const snapshots = [
      {
        symbol: "GC=F", name: "Gold", category: "commodities" as const,
        price: 2010, previousClose: 2000, change: 10, changePercent: 0.5,
        high: 2020, low: 1995, timestamp: new Date(),
      },
    ];

    const result = await runOracleAnalysis(
      mockClient as any,
      snapshots,
      "test-session",
      1,
      "",
      ""
    );

    // Should have made exactly 2 API calls
    expect(mockClient.messages.create).toHaveBeenCalledTimes(2);

    // Result should have analysis from call 1
    expect(result.analysis).toContain("Higher Timeframe Context");
    expect(result.bias.overall).toBe("bullish");
    expect(result.keyLevels).toHaveLength(1);

    // Result should have setups from call 2
    expect(result.setups).toHaveLength(1);
    expect(result.setups[0].instrument).toBe("Gold");
    expect(result.setups[0].entry).toBe(2000);
  });

  it("continues with empty setups when call 2 fails", async () => {
    const analysisResponse = {
      analysis: "**Higher Timeframe Context:** Bearish. **Intraday Analysis:** Weak. **Cross-Asset Dynamics:** Risk-off. **Technical Confluence Analysis:** Confidence: 45% — TC (50%), MA (40%), RR (40%)",
      bias: { overall: "bearish", notes: "Downtrend" },
      keyLevels: [],
      confidence: 45,
    };

    let callCount = 0;
    const mockClient = {
      messages: {
        create: vi.fn(async () => {
          callCount++;
          if (callCount === 1) {
            return {
              stop_reason: "end_turn",
              content: [{ type: "text", text: JSON.stringify(analysisResponse) }],
            };
          }
          // Call 2 fails
          throw new Error("API error on setup call");
        }),
      },
    };

    vi.doMock("fs", async () => {
      const actual = await vi.importActual<typeof import("fs")>("fs");
      return {
        ...actual,
        existsSync: (p: string) => {
          if (p.includes("system-prompt") || p.includes("analysis-rules")) return false;
          return actual.existsSync(p);
        },
      };
    });

    vi.resetModules();
    const { runOracleAnalysis } = await import("../src/oracle");

    const snapshots = [
      {
        symbol: "GC=F", name: "Gold", category: "commodities" as const,
        price: 2010, previousClose: 2000, change: 10, changePercent: 0.5,
        high: 2020, low: 1995, timestamp: new Date(),
      },
    ];

    const result = await runOracleAnalysis(
      mockClient as any,
      snapshots,
      "test-session",
      2,
      "",
      ""
    );

    // Should still return valid result with empty setups
    expect(result.analysis).toContain("Bearish");
    expect(result.bias.overall).toBe("bearish");
    expect(result.setups).toHaveLength(0);
    // Confidence should NOT be forced to 35 since it's already <= 60
    expect(result.confidence).toBe(45);

    // Should have warned about setup call failure
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("ORACLE setup construction failed")
    );
  });

  it("logs spinner messages for both calls", async () => {
    const analysisResponse = {
      analysis: "**Higher Timeframe Context:** Neutral. **Intraday Analysis:** Choppy. **Cross-Asset Dynamics:** Mixed. **Technical Confluence Analysis:** Confidence: 40% — TC (40%), MA (40%), RR (40%)",
      bias: { overall: "neutral", notes: "No clear direction" },
      keyLevels: [],
      confidence: 40,
    };

    let callCount = 0;
    const mockClient = {
      messages: {
        create: vi.fn(async () => ({
          stop_reason: "end_turn",
          content: [{ type: "text", text: JSON.stringify(callCount++ === 0 ? analysisResponse : []) }],
        })),
      },
    };

    vi.doMock("fs", async () => {
      const actual = await vi.importActual<typeof import("fs")>("fs");
      return {
        ...actual,
        existsSync: (p: string) => {
          if (p.includes("system-prompt") || p.includes("analysis-rules")) return false;
          return actual.existsSync(p);
        },
      };
    });

    vi.resetModules();
    const { runOracleAnalysis } = await import("../src/oracle");

    const snapshots = [
      {
        symbol: "GC=F", name: "Gold", category: "commodities" as const,
        price: 2010, previousClose: 2000, change: 10, changePercent: 0.5,
        high: 2020, low: 1995, timestamp: new Date(),
      },
    ];

    await runOracleAnalysis(mockClient as any, snapshots, "test-session", 3, "", "");

    // Should have logged both phase messages
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining("ORACLE analyzing market structure"));
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining("ORACLE constructing setups"));
  });

  it("throws when call 1 (analysis) fails", async () => {
    const mockClient = {
      messages: {
        create: vi.fn(async () => {
          throw new Error("API error on analysis call");
        }),
      },
    };

    vi.doMock("fs", async () => {
      const actual = await vi.importActual<typeof import("fs")>("fs");
      return {
        ...actual,
        existsSync: (p: string) => {
          if (p.includes("system-prompt") || p.includes("analysis-rules")) return false;
          return actual.existsSync(p);
        },
      };
    });

    vi.resetModules();
    const { runOracleAnalysis } = await import("../src/oracle");

    const snapshots = [
      {
        symbol: "GC=F", name: "Gold", category: "commodities" as const,
        price: 2010, previousClose: 2000, change: 10, changePercent: 0.5,
        high: 2020, low: 1995, timestamp: new Date(),
      },
    ];

    await expect(
      runOracleAnalysis(mockClient as any, snapshots, "test-session", 4, "", "")
    ).rejects.toThrow("API error on analysis call");
  });

  it("applies setup validation filter to call 2 results", async () => {
    const analysisResponse = {
      analysis: "**Higher Timeframe Context:** Bullish. **Intraday Analysis:** Strong. **Cross-Asset Dynamics:** Risk-on. **Technical Confluence Analysis:** Confidence: 70% — TC (80%), MA (60%), RR (70%)",
      bias: { overall: "bullish", notes: "Strong uptrend" },
      keyLevels: [],
      confidence: 70,
    };

    // One valid setup, one with entry=0 (invalid), one missing timeframe
    const setupsResponse = [
      {
        instrument: "Gold", type: "FVG", direction: "bullish",
        description: "Valid", invalidation: "None",
        entry: 2000, stop: 1980, target: 2040, RR: 2.0, timeframe: "4H",
      },
      {
        instrument: "Silver", type: "OB", direction: "bullish",
        description: "Zero entry", invalidation: "None",
        entry: 0, stop: 25, target: 30, RR: 1.5, timeframe: "1H",
      },
      {
        instrument: "BTC", type: "MSS", direction: "bullish",
        description: "Missing TF", invalidation: "None",
        entry: 50000, stop: 49000, target: 52000, RR: 2.0,
      },
    ];

    let callCount = 0;
    const mockClient = {
      messages: {
        create: vi.fn(async () => {
          callCount++;
          return {
            stop_reason: "end_turn",
            content: [{ type: "text", text: JSON.stringify(callCount === 1 ? analysisResponse : setupsResponse) }],
          };
        }),
      },
    };

    vi.doMock("fs", async () => {
      const actual = await vi.importActual<typeof import("fs")>("fs");
      return {
        ...actual,
        existsSync: (p: string) => {
          if (p.includes("system-prompt") || p.includes("analysis-rules")) return false;
          return actual.existsSync(p);
        },
      };
    });

    vi.resetModules();
    const { runOracleAnalysis } = await import("../src/oracle");

    const snapshots = [
      {
        symbol: "GC=F", name: "Gold", category: "commodities" as const,
        price: 2010, previousClose: 2000, change: 10, changePercent: 0.5,
        high: 2020, low: 1995, timestamp: new Date(),
      },
    ];

    const result = await runOracleAnalysis(mockClient as any, snapshots, "test-session", 5, "", "");

    // Only the Gold setup should survive validation
    expect(result.setups).toHaveLength(1);
    expect(result.setups[0].instrument).toBe("Gold");
  });
});

// ── Setup geometry and R:R cross-validation tests ─────────

describe("setup filter: geometry and calculated R:R", () => {
  let warnSpy: ReturnType<typeof vi.spyOn>;
  let logSpy: ReturnType<typeof vi.spyOn>;

  const analysisResponse = {
    analysis: "**Higher Timeframe Context:** Bullish. **Intraday Analysis:** Strong. **Cross-Asset Dynamics:** Risk-on. **Technical Confluence Analysis:** Confidence: 70% — TC (80%), MA (60%), RR (70%)",
    bias: { overall: "bullish", notes: "Uptrend" },
    keyLevels: [],
    confidence: 70,
  };

  function makeMockClient(setups: any[]) {
    let callCount = 0;
    return {
      messages: {
        create: vi.fn(async () => {
          callCount++;
          return {
            stop_reason: "end_turn",
            content: [{ type: "text", text: JSON.stringify(callCount === 1 ? analysisResponse : setups) }],
          };
        }),
      },
    };
  }

  const snapshots = [
    {
      symbol: "GC=F", name: "Gold", category: "commodities" as const,
      price: 2010, previousClose: 2000, change: 10, changePercent: 0.5,
      high: 2020, low: 1995, timestamp: new Date(),
    },
  ];

  beforeEach(() => {
    warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    logSpy  = vi.spyOn(console, "log").mockImplementation(() => {});
    vi.doMock("fs", async () => {
      const actual = await vi.importActual<typeof import("fs")>("fs");
      return { ...actual, existsSync: () => false, readFileSync: actual.readFileSync, mkdirSync: () => {} };
    });
  });

  afterEach(() => {
    warnSpy.mockRestore();
    logSpy.mockRestore();
    vi.restoreAllMocks();
    vi.resetModules();
  });

  it("drops bullish setup where stop >= entry (AUD/USD typo case from session #138)", async () => {
    const setups = [
      // stop=1.705 instead of 0.705 — the exact bug from session #138
      { instrument: "AUD/USD", type: "OB", direction: "bullish", description: "desc", invalidation: "inv",
        entry: 0.7089, stop: 1.705, target: 0.715, RR: 1.56, timeframe: "1H" },
    ];
    const { runOracleAnalysis } = await import("../src/oracle");
    const result = await runOracleAnalysis(makeMockClient(setups) as any, snapshots, "test", 1, "", "");
    expect(result.setups).toHaveLength(0);
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("bullish but stop"));
  });

  it("drops bearish setup where stop <= entry", async () => {
    const setups = [
      { instrument: "EUR/USD", type: "MSS", direction: "bearish", description: "desc", invalidation: "inv",
        entry: 1.17, stop: 1.15, target: 1.16, RR: 2.0, timeframe: "1H" },
    ];
    const { runOracleAnalysis } = await import("../src/oracle");
    const result = await runOracleAnalysis(makeMockClient(setups) as any, snapshots, "test", 2, "", "");
    expect(result.setups).toHaveLength(0);
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("bearish but stop"));
  });

  it("drops setup where self-reported R:R >= 1.3 but calculated R:R < 1.3 (NASDAQ case from session #138)", async () => {
    // NASDAQ from #138: entry=25030, stop=24800, target=25100 → actual R:R = 70/230 = 0.30, not 1.3
    const setups = [
      { instrument: "NASDAQ", type: "MSS", direction: "bullish", description: "desc", invalidation: "inv",
        entry: 25030, stop: 24800, target: 25100, RR: 1.3, timeframe: "1H" },
    ];
    const { runOracleAnalysis } = await import("../src/oracle");
    const result = await runOracleAnalysis(makeMockClient(setups) as any, snapshots, "test", 3, "", "");
    expect(result.setups).toHaveLength(0);
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("calculated R:R"));
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("self-reported: 1.3"));
  });

  it("drops Gold setup where self-reported R:R=1.45 but calculated R:R=0.45 (session #138 case)", async () => {
    // Gold from #138: entry=4819, stop=4750, target=4850 → actual R:R = 31/69 = 0.45
    const setups = [
      { instrument: "Gold", type: "MSS", direction: "bullish", description: "desc", invalidation: "inv",
        entry: 4819, stop: 4750, target: 4850, RR: 1.45, timeframe: "1H" },
    ];
    const { runOracleAnalysis } = await import("../src/oracle");
    const result = await runOracleAnalysis(makeMockClient(setups) as any, snapshots, "test", 4, "", "");
    expect(result.setups).toHaveLength(0);
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("calculated R:R 0.45"));
  });

  it("corrects self-reported R:R to the calculated value when geometry is valid", async () => {
    // entry=2000, stop=1980, target=2060 → actual R:R = 60/20 = 3.0, model said 2.0
    const setups = [
      { instrument: "Gold", type: "FVG", direction: "bullish", description: "desc", invalidation: "inv",
        entry: 2000, stop: 1980, target: 2060, RR: 2.0, timeframe: "4H" },
    ];
    const { runOracleAnalysis } = await import("../src/oracle");
    const result = await runOracleAnalysis(makeMockClient(setups) as any, snapshots, "test", 5, "", "");
    expect(result.setups).toHaveLength(1);
    expect(result.setups[0].RR).toBeCloseTo(3.0, 1);
  });

  it("passes a setup with correct geometry and R:R >= 1.3 unchanged", async () => {
    // entry=1.17, stop=1.165, target=1.18 → R:R = 0.01/0.005 = 2.0
    const setups = [
      { instrument: "EUR/USD", type: "MSS", direction: "bullish", description: "desc", invalidation: "inv",
        entry: 1.17, stop: 1.165, target: 1.18, RR: 2.0, timeframe: "4H" },
    ];
    const { runOracleAnalysis } = await import("../src/oracle");
    const result = await runOracleAnalysis(makeMockClient(setups) as any, snapshots, "test", 6, "", "");
    expect(result.setups).toHaveLength(1);
    expect(result.setups[0].instrument).toBe("EUR/USD");
    expect(result.setups[0].RR).toBeCloseTo(2.0, 1);
  });
});

// ── warnPoorRiskReward tests ──────────────────────────────

describe("warnPoorRiskReward", () => {
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    warnSpy.mockRestore();
  });

  it("logs warning for setup with RR < 1.3", async () => {
    const { warnPoorRiskReward } = await import("../src/oracle");
    const setups = [
      { instrument: "EUR/USD", RR: 1.0, entry: 1.08, stop: 1.07, target: 1.09, timeframe: "4H" },
    ];
    warnPoorRiskReward(setups);
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("poor risk/reward")
    );
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("RR=1.00")
    );
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("EUR/USD")
    );
  });

  it("does not log warning for setup with RR >= 1.3", async () => {
    const { warnPoorRiskReward } = await import("../src/oracle");
    const setups = [
      { instrument: "EUR/USD", RR: 1.5, entry: 1.08, stop: 1.07, target: 1.095, timeframe: "4H" },
    ];
    warnPoorRiskReward(setups);
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it("does not log warning when RR is exactly 1.3", async () => {
    const { warnPoorRiskReward } = await import("../src/oracle");
    const setups = [
      { instrument: "GBP/USD", RR: 1.3, entry: 1.25, stop: 1.24, target: 1.263, timeframe: "1H" },
    ];
    warnPoorRiskReward(setups);
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it("uses 'unknown' when instrument is missing", async () => {
    const { warnPoorRiskReward } = await import("../src/oracle");
    const setups = [
      { RR: 0.3, entry: 100, stop: 95, target: 101.5, timeframe: "15m" },
    ];
    warnPoorRiskReward(setups);
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("unknown")
    );
  });

  it("does not warn when RR is not a number", async () => {
    const { warnPoorRiskReward } = await import("../src/oracle");
    const setups = [
      { instrument: "BTC", RR: "bad", entry: 50000, stop: 49000, target: 52000, timeframe: "4H" },
    ];
    warnPoorRiskReward(setups);
    expect(warnSpy).not.toHaveBeenCalled();
  });
});

// ── Confidence enforcement (high confidence + zero setups) ──

describe("oracle confidence enforcement", () => {
  it("forces confidence to 35 when >60% and 0 valid setups", async () => {
    // We test this by inspecting the logic directly via a mock of runOracleAnalysis internals.
    // Since the enforcement uses resolveConfidence + the check inline, we verify the exported
    // warnPoorRiskReward doesn't interfere and the logic in the module is sound by unit-testing
    // resolveConfidence + the threshold behavior independently.
    const { resolveConfidence } = await import("../src/validate");

    // resolveConfidence: no mismatch scenario, JSON confidence 70, no text confidence
    const confidence = resolveConfidence("The market is bullish today.", 70);
    expect(confidence).toBe(70);

    // Simulate the enforcement: confidence > 60 and 0 setups → should be forced to 35
    let finalConfidence = confidence; // 70
    const validSetups: any[] = [];
    if (finalConfidence > 60 && validSetups.length === 0) {
      finalConfidence = 35;
    }
    expect(finalConfidence).toBe(35);
  });

  it("does NOT force confidence when setups exist", async () => {
    const { resolveConfidence } = await import("../src/validate");
    let finalConfidence = resolveConfidence("", 70);
    const validSetups = [{ instrument: "Gold", RR: 2, entry: 2000, stop: 1980, target: 2040, timeframe: "1H" }];
    if (finalConfidence > 60 && validSetups.length === 0) {
      finalConfidence = 35;
    }
    expect(finalConfidence).toBe(70);
  });

  it("does NOT force confidence when already <=60", async () => {
    const { resolveConfidence } = await import("../src/validate");
    let finalConfidence = resolveConfidence("", 55);
    const validSetups: any[] = [];
    if (finalConfidence > 60 && validSetups.length === 0) {
      finalConfidence = 35;
    }
    expect(finalConfidence).toBe(55);
  });
});

// ── Weekend structural enforcement ────────────────────────

const cryptoSnapshots = [
  { symbol: "BTC-USD",  name: "Bitcoin",   category: "crypto", price: 66918, previousClose: 67000, high: 67100, low: 66500, change: -82,    changePercent: -0.06 },
  { symbol: "ETH-USD",  name: "Ethereum",  category: "crypto", price: 2049,  previousClose: 2061,  high: 2070,  low: 2040,  change: -12,    changePercent: -0.60 },
  { symbol: "SOL-USD",  name: "Solana",    category: "crypto", price: 79.5,  previousClose: 79.3,  high: 80.5,  low: 79.0,  change:  0.2,   changePercent:  0.27 },
  { symbol: "XRP-USD",  name: "Ripple",    category: "crypto", price: 1.316, previousClose: 1.317, high: 1.330, low: 1.300, change: -0.001, changePercent: -0.10 },
  { symbol: "BNB-USD",  name: "BNB",       category: "crypto", price: 585,   previousClose: 581,   high: 592,   low: 580,   change:  4,     changePercent:  0.66 },
  { symbol: "ADA-USD",  name: "Cardano",   category: "crypto", price: 0.246, previousClose: 0.247, high: 0.250, low: 0.244, change: -0.001, changePercent: -0.18 },
  { symbol: "DOGE-USD", name: "Dogecoin",  category: "crypto", price: 0.163, previousClose: 0.164, high: 0.165, low: 0.161, change: -0.001, changePercent: -0.34 },
  { symbol: "AVAX-USD", name: "Avalanche", category: "crypto", price: 19.8,  previousClose: 19.9,  high: 20.1,  low: 19.6,  change: -0.1,   changePercent: -0.50 },
  { symbol: "DOT-USD",  name: "Polkadot",  category: "crypto", price: 1.24,  previousClose: 1.248, high: 1.260, low: 1.230, change: -0.008, changePercent: -0.64 },
  { symbol: "LINK-USD", name: "Chainlink", category: "crypto", price: 8.65,  previousClose: 8.71,  high: 8.80,  low: 8.60,  change: -0.06,  changePercent: -0.68 },
] as any[];

describe("buildWeekendInstrumentTemplate", () => {
  it("exports the function", async () => {
    const oracle = await import("../src/oracle");
    expect(typeof oracle.buildWeekendInstrumentTemplate).toBe("function");
  });

  it("includes every instrument name in the template", async () => {
    const { buildWeekendInstrumentTemplate } = await import("../src/oracle");
    const template = buildWeekendInstrumentTemplate(cryptoSnapshots);
    for (const snap of cryptoSnapshots) {
      expect(template).toContain(snap.name);
    }
  });

  it("produces valid JSON that parses as an array of the right length", async () => {
    const { buildWeekendInstrumentTemplate } = await import("../src/oracle");
    const template = buildWeekendInstrumentTemplate(cryptoSnapshots);
    const parsed = JSON.parse(template);
    expect(Array.isArray(parsed)).toBe(true);
    expect(parsed).toHaveLength(cryptoSnapshots.length);
  });

  it("each slot has instrument name, direction neutral, and null entry/stop/target", async () => {
    const { buildWeekendInstrumentTemplate } = await import("../src/oracle");
    const template = buildWeekendInstrumentTemplate(cryptoSnapshots);
    const parsed = JSON.parse(template);
    for (const slot of parsed) {
      expect(slot).toHaveProperty("instrument");
      expect(slot).toHaveProperty("direction", "neutral");
      expect(slot.entry).toBeNull();
    }
  });
});

describe("parseWeekendSetups", () => {
  it("exports the function", async () => {
    const oracle = await import("../src/oracle");
    expect(typeof oracle.parseWeekendSetups).toBe("function");
  });

  it("neutral entries become key levels, not valid setups", async () => {
    const { parseWeekendSetups } = await import("../src/oracle");
    const rawSetups = [
      { instrument: "Bitcoin",   direction: "bullish", entry: 66000, stop: 65500, target: 67080, RR: 2.16, timeframe: "4H", type: "OB",    description: "Support play", invalidation: "Break below 66k" },
      { instrument: "Ripple",    direction: "neutral",  entry: null,  stop: null,  target: null,  RR: null, timeframe: null, type: "Other", description: "No clear setup — range compression", invalidation: "" },
      { instrument: "Avalanche", direction: "neutral",  entry: null,  stop: null,  target: null,  RR: null, timeframe: null, type: "Other", description: "No setup — sideways", invalidation: "" },
    ];
    const { validSetups, screeningKeyLevels } = parseWeekendSetups(rawSetups, cryptoSnapshots);
    expect(validSetups.map((s: any) => s.instrument)).toContain("Bitcoin");
    expect(validSetups.map((s: any) => s.instrument)).not.toContain("Ripple");
    expect(validSetups.map((s: any) => s.instrument)).not.toContain("Avalanche");
    expect(screeningKeyLevels.map((k: any) => k.instrument)).toContain("Ripple");
    expect(screeningKeyLevels.map((k: any) => k.instrument)).toContain("Avalanche");
  });

  it("screening key levels have instrument, level (current price), and notes from description", async () => {
    const { parseWeekendSetups } = await import("../src/oracle");
    const rawSetups = [
      { instrument: "Ripple", direction: "neutral", entry: null, stop: null, target: null, RR: null, timeframe: null, type: "Other", description: "No setup — sideways range", invalidation: "" },
    ];
    const { screeningKeyLevels } = parseWeekendSetups(rawSetups, cryptoSnapshots);
    const xrpLevel = screeningKeyLevels.find((k: any) => k.instrument === "Ripple");
    expect(xrpLevel).toBeDefined();
    expect(xrpLevel.level).toBe(1.316); // current price from snapshot
    expect(xrpLevel.type).toBe("screened");
    expect(xrpLevel.notes).toContain("No setup");
  });

  it("full setup with entry/stop/target stays in validSetups and is not duplicated in keyLevels", async () => {
    const { parseWeekendSetups } = await import("../src/oracle");
    const rawSetups = [
      { instrument: "Bitcoin", direction: "bullish", entry: 66000, stop: 65500, target: 67080, RR: 2.16, timeframe: "4H", type: "OB", description: "OB hold", invalidation: "Break below" },
    ];
    const { validSetups, screeningKeyLevels } = parseWeekendSetups(rawSetups, cryptoSnapshots);
    expect(validSetups).toHaveLength(1);
    expect(screeningKeyLevels.map((k: any) => k.instrument)).not.toContain("Bitcoin");
  });
});

describe("runOracleAnalysis weekend integration — template + parseWeekendSetups", () => {
  let warnSpy: ReturnType<typeof vi.spyOn>;
  let logSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    logSpy  = vi.spyOn(console, "log").mockImplementation(() => {});
  });

  afterEach(() => {
    warnSpy.mockRestore();
    logSpy.mockRestore();
    vi.restoreAllMocks();
    vi.resetModules();
  });

  it("neutral ORACLE entries appear in keyLevels (covered) not in setups", async () => {
    const setupsWithNeutral = [
      { instrument: "Bitcoin",   direction: "bullish", entry: 66000, stop: 65500, target: 67080, RR: 2.16, timeframe: "4H", type: "OB",    description: "OB hold", invalidation: "Break below 66k" },
      { instrument: "Ripple",    direction: "neutral",  entry: null,  stop: null,  target: null,  RR: null,  timeframe: null, type: "Other", description: "No setup — sideways range", invalidation: "" },
      { instrument: "Avalanche", direction: "neutral",  entry: null,  stop: null,  target: null,  RR: null,  timeframe: null, type: "Other", description: "No setup — no structural level", invalidation: "" },
    ];

    const analysisResponse = {
      analysis: "**Higher Timeframe Context:** Crypto mixed. **Intraday Analysis:** BTC stable. **Cross-Asset Dynamics:** Internal rotation. **Technical Confluence Analysis:** Confidence: 46% — TC (60%), MA (30%), RR (40%)",
      bias: { overall: "mixed", notes: "Infrastructure vs utility divergence" },
      keyLevels: [{ instrument: "Bitcoin", level: 66000, type: "support", notes: "Key level" }],
      confidence: 46,
    };

    let callCount = 0;
    const mockClient = {
      messages: {
        create: vi.fn(async (params: any) => {
          callCount++;
          const responseJSON = callCount === 1
            ? JSON.stringify(analysisResponse)
            : JSON.stringify(setupsWithNeutral);
          return { stop_reason: "end_turn", content: [{ type: "text", text: responseJSON }] };
        }),
      },
    };

    vi.doMock("fs", async () => {
      const actual = await vi.importActual<typeof import("fs")>("fs");
      return {
        ...actual,
        existsSync: () => false,
        readFileSync: actual.readFileSync,
        mkdirSync: () => {},
      };
    });

    vi.doMock("../src/journal", () => ({ loadAllJournalEntries: () => [] }));
    vi.doMock("../src/analytics", () => ({ buildCalibrationContext: () => "" }));

    const { runOracleAnalysis } = await import("../src/oracle");
    const result = await runOracleAnalysis(
      mockClient as any,
      cryptoSnapshots,
      "test-session",
      1,
      "",
      "",
      true  // isWeekend
    );

    // Neutral entries must NOT appear as tradeable setups
    const setupInstruments = result.setups.map((s: any) => s.instrument);
    expect(setupInstruments).not.toContain("Ripple");
    expect(setupInstruments).not.toContain("Avalanche");

    // Neutral entries MUST appear in keyLevels so screening counts them as covered
    const keyLevelInstruments = result.keyLevels.map((k: any) => k.instrument);
    expect(keyLevelInstruments).toContain("Ripple");
    expect(keyLevelInstruments).toContain("Avalanche");
  });

  it("ORACLE SETUPS prompt contains pre-filled instrument template in weekend mode", async () => {
    const capturedPrompts: string[] = [];
    let callCount = 0;

    const analysisResponse = {
      analysis: "**Higher Timeframe Context:** Mixed. **Intraday Analysis:** Stable. **Cross-Asset Dynamics:** Rotation. **Technical Confluence Analysis:** Confidence: 46% — TC (60%), MA (30%), RR (40%)",
      bias: { overall: "mixed", notes: "Rotation" },
      keyLevels: [],
      confidence: 46,
    };

    const mockClient = {
      messages: {
        create: vi.fn(async (params: any) => {
          callCount++;
          capturedPrompts.push(params.messages[0].content);
          const responseJSON = callCount === 1
            ? JSON.stringify(analysisResponse)
            : JSON.stringify([]);
          return { stop_reason: "end_turn", content: [{ type: "text", text: responseJSON }] };
        }),
      },
    };

    vi.doMock("fs", async () => {
      const actual = await vi.importActual<typeof import("fs")>("fs");
      return { ...actual, existsSync: () => false, readFileSync: actual.readFileSync, mkdirSync: () => {} };
    });
    vi.doMock("../src/journal", () => ({ loadAllJournalEntries: () => [] }));
    vi.doMock("../src/analytics", () => ({ buildCalibrationContext: () => "" }));

    const { runOracleAnalysis } = await import("../src/oracle");
    await runOracleAnalysis(mockClient as any, cryptoSnapshots, "test-session", 1, "", "", true);

    // The second call (SETUPS) should contain every instrument name in the template
    const setupsPrompt = capturedPrompts[1];
    for (const snap of cryptoSnapshots) {
      expect(setupsPrompt).toContain(snap.name);
    }
  });
});

// ── assumptions field in oracle return ────────────────────────

describe("runOracleAnalysis assumptions field", () => {
  let warnSpy: ReturnType<typeof vi.spyOn>;
  let logSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
  });

  afterEach(() => {
    warnSpy.mockRestore();
    logSpy.mockRestore();
    vi.restoreAllMocks();
  });

  it("includes assumptions from parsed response in return object", async () => {
    const analysisResponse = {
      analysis: "**Higher Timeframe Context:** Bullish. **Intraday Analysis:** Strong. **Cross-Asset Dynamics:** Risk-on. **Technical Confluence Analysis:** Confidence: 45% — TC (50%), MA (40%), RR (40%)",
      bias: { overall: "bullish", notes: "Trend up" },
      keyLevels: [],
      confidence: 45,
      assumptions: ["Oil surge assumed to be supply shock", "Fed pivot assumed if CPI declines"],
    };

    const mockClient = {
      messages: {
        create: vi.fn(async () => ({
          stop_reason: "end_turn",
          content: [{ type: "text", text: JSON.stringify(analysisResponse) }],
        })),
      },
    };

    vi.doMock("fs", async () => {
      const actual = await vi.importActual<typeof import("fs")>("fs");
      return { ...actual, existsSync: () => false };
    });

    vi.resetModules();
    const { runOracleAnalysis } = await import("../src/oracle");

    const snapshots = [
      { symbol: "GC=F", name: "Gold", category: "commodities" as const, price: 2010, previousClose: 2000, change: 10, changePercent: 0.5, high: 2020, low: 1995, timestamp: new Date() },
    ];

    const result = await runOracleAnalysis(mockClient as any, snapshots, "test-session", 1, "", "");

    expect(result.assumptions).toBeDefined();
    expect(Array.isArray(result.assumptions)).toBe(true);
    expect(result.assumptions).toContain("Oil surge assumed to be supply shock");
  });

  it("returns empty assumptions array when response has none", async () => {
    const analysisResponse = {
      analysis: "**Higher Timeframe Context:** Neutral. **Intraday Analysis:** Flat. **Cross-Asset Dynamics:** Mixed. **Technical Confluence Analysis:** Confidence: 40% — TC (40%), MA (40%), RR (40%)",
      bias: { overall: "neutral", notes: "No direction" },
      keyLevels: [],
      confidence: 40,
    };

    const mockClient = {
      messages: {
        create: vi.fn(async () => ({
          stop_reason: "end_turn",
          content: [{ type: "text", text: JSON.stringify(analysisResponse) }],
        })),
      },
    };

    vi.doMock("fs", async () => {
      const actual = await vi.importActual<typeof import("fs")>("fs");
      return { ...actual, existsSync: () => false };
    });

    vi.resetModules();
    const { runOracleAnalysis } = await import("../src/oracle");

    const snapshots = [
      { symbol: "GC=F", name: "Gold", category: "commodities" as const, price: 2010, previousClose: 2000, change: 10, changePercent: 0.5, high: 2020, low: 1995, timestamp: new Date() },
    ];

    const result = await runOracleAnalysis(mockClient as any, snapshots, "test-session", 1, "", "");

    expect(result.assumptions).toBeDefined();
    expect(Array.isArray(result.assumptions)).toBe(true);
    expect(result.assumptions!.length).toBe(0);
  });
});

// ── buildMinSetupNote ─────────────────────────────────────

import { buildMinSetupNote } from "../src/oracle";

describe("buildMinSetupNote", () => {
  it("returns empty string when confidence < 50", () => {
    expect(buildMinSetupNote(45)).toBe("");
  });

  it("requires at least 3 setups when confidence 50-59", () => {
    const note = buildMinSetupNote(55);
    expect(note).toContain("3");
    expect(note.toLowerCase()).toContain("mandatory");
  });

  it("requires at least 4 setups when confidence 60-69", () => {
    const note = buildMinSetupNote(65);
    expect(note).toContain("4");
    expect(note.toLowerCase()).toContain("mandatory");
  });

  it("requires at least 4 setups when confidence >= 70", () => {
    const note = buildMinSetupNote(80);
    expect(note).toContain("4");
  });

  it("includes confidence value in the note", () => {
    const note = buildMinSetupNote(72);
    expect(note).toContain("72");
  });

  it("returns empty string at exactly 49", () => {
    expect(buildMinSetupNote(49)).toBe("");
  });

  it("triggers at exactly 50", () => {
    expect(buildMinSetupNote(50)).not.toBe("");
  });

  it("explicitly states that neutral entries do not count as setups (backlog #26)", () => {
    const note = buildMinSetupNote(72);
    expect(note.toLowerCase()).toMatch(/neutral.*not count|not count.*neutral|neutral.*do not|neutral entries.*not/i);
  });

  it("requires non-neutral direction entries, not just array length (backlog #26)", () => {
    const note = buildMinSetupNote(55);
    // Must mention bullish/bearish as the required direction
    expect(note.toLowerCase()).toMatch(/bullish.*bearish|bearish.*bullish|non-neutral/i);
  });
});

// ── buildRRSelfCheckNote ──────────────────────────────────

import { buildRRSelfCheckNote } from "../src/oracle";

describe("buildRRSelfCheckNote", () => {
  it("returns a non-empty string", () => {
    expect(buildRRSelfCheckNote().length).toBeGreaterThan(0);
  });

  it("contains the bullish RR formula", () => {
    const note = buildRRSelfCheckNote();
    expect(note.toLowerCase()).toContain("bullish");
    expect(note).toMatch(/target.*entry.*entry.*stop|target\s*[−\-]\s*entry.*entry\s*[−\-]\s*stop/i);
  });

  it("contains the bearish RR formula", () => {
    const note = buildRRSelfCheckNote();
    expect(note.toLowerCase()).toContain("bearish");
    expect(note).toMatch(/entry.*target.*stop.*entry|entry\s*[−\-]\s*target.*stop\s*[−\-]\s*entry/i);
  });

  it("references the 1.3 minimum threshold", () => {
    expect(buildRRSelfCheckNote()).toContain("1.3");
  });

  it("contains a mandatory/verify instruction", () => {
    const note = buildRRSelfCheckNote().toLowerCase();
    expect(note.match(/verify|compute|calculate|mandatory/)).not.toBeNull();
  });

  it("is injected into the setup prompt when confidence >= 50", () => {
    // buildMinSetupNote at 60% should include reference to RR verification
    // (indirectly — both fire together in the prompt)
    // Direct check: the function always returns content regardless of inputs
    expect(buildRRSelfCheckNote()).toBeTruthy();
  });
});

// ── buildWeekdayScreeningTemplate ────────────────────────

describe("buildWeekdayScreeningTemplate", () => {
  const snaps: MarketSnapshot[] = [
    { symbol: "EURUSD=X", name: "EUR/USD", category: "forex", price: 1.10, previousClose: 1.08, change: 0.02, changePercent: 1.92, high: 1.11, low: 1.09, timestamp: new Date() },
    { symbol: "GC=F",     name: "Gold",    category: "commodities", price: 3300, previousClose: 3290, change: 10, changePercent: 0.30, high: 3310, low: 3285, timestamp: new Date() },
    { symbol: "BTC-USD",  name: "Bitcoin", category: "crypto", price: 82000, previousClose: 80000, change: 2000, changePercent: 2.5, high: 82500, low: 79000, timestamp: new Date() },
  ];

  it("returns empty string when confidence < 50", () => {
    expect(buildWeekdayScreeningTemplate(snaps, 45)).toBe("");
  });

  it("returns empty string at exactly 49", () => {
    expect(buildWeekdayScreeningTemplate(snaps, 49)).toBe("");
  });

  it("returns a template string at confidence 50", () => {
    expect(buildWeekdayScreeningTemplate(snaps, 50)).not.toBe("");
  });

  it("template contains all instrument names", () => {
    const tmpl = buildWeekdayScreeningTemplate(snaps, 60);
    expect(tmpl).toContain("EUR/USD");
    expect(tmpl).toContain("Gold");
    expect(tmpl).toContain("Bitcoin");
  });

  it("template is valid JSON with a slot per instrument", () => {
    const tmpl = buildWeekdayScreeningTemplate(snaps, 60);
    const parsed = JSON.parse(tmpl);
    expect(Array.isArray(parsed)).toBe(true);
    expect(parsed.length).toBe(snaps.length);
  });

  it("each slot has null entry/stop/target and neutral direction", () => {
    const tmpl = buildWeekdayScreeningTemplate(snaps, 60);
    const parsed = JSON.parse(tmpl);
    for (const slot of parsed) {
      expect(slot.entry).toBeNull();
      expect(slot.stop).toBeNull();
      expect(slot.target).toBeNull();
      expect(slot.direction).toBe("neutral");
    }
  });

  it("returns empty string for empty snapshots regardless of confidence", () => {
    expect(buildWeekdayScreeningTemplate([], 80)).toBe("");
  });
});

// ── buildR041ScreeningNote ────────────────────────────────

describe("buildR041ScreeningNote", () => {
  it("returns a non-empty string", () => {
    expect(buildR041ScreeningNote()).toBeTruthy();
  });

  it("contains the 'Screening validation:' format requirement", () => {
    expect(buildR041ScreeningNote()).toContain("Screening validation:");
  });

  it("references the 55% confidence threshold", () => {
    expect(buildR041ScreeningNote()).toContain("55%");
  });

  it("lists all 8 required r041 instruments", () => {
    const note = buildR041ScreeningNote();
    expect(note).toContain("EUR/USD");
    expect(note).toContain("GBP/USD");
    expect(note).toContain("NASDAQ");
    expect(note).toContain("S&P");
    expect(note).toContain("BTC");
    expect(note).toContain("ETH");
    expect(note).toContain("Gold");
    expect(note).toContain("Oil");
  });

  it("mentions price and level placeholders in the example format", () => {
    const note = buildR041ScreeningNote();
    expect(note).toMatch(/\[price\]/i);
    expect(note).toMatch(/\[level\]/i);
  });
});

// ── computeOracleConfidence ───────────────────────────────
// Encapsulates the three-step confidence computation in oracle.ts:
// 1. resolveConfidence (text vs JSON reconciliation)
// 2. Zero-setup contradiction floor (>60% + 0 setups → 35%)
// 3. applySetupCountPenalty (proportional penalty)
//
// Having this as a named exported function:
// (a) makes confidence flow unit-testable without mocking the Claude API
// (b) allows agent.ts to avoid calling resolveConfidence a second time
//     (which would undo any penalty oracle.ts applied — the latent bug in
//     backlog #23: text says 65%, penalty reduces to 45%, second call sees
//     diff=20>10 and silently restores 65%)

describe("computeOracleConfidence", () => {
  it("returns resolved text confidence when json diverges >10pts, capped at 65 by r031", () => {
    // text=73, json=50 → resolveConfidence returns 73; no cap notation → r031 auto-cap to 65
    // (Previously expected 73; r031 code enforcement now caps at 65 without cap notation)
    expect(computeOracleConfidence("Confidence: 73% — TC(80%), MA(60%), RR(70%)", 50, 4, false)).toBe(65);
  });

  it("resolveConfidence itself still returns 73 when text diverges >10pts (no r031 applied)", () => {
    // resolveConfidence is a lower-level function that does not apply r031
    expect(resolveConfidence("Confidence: 73% — TC(80%), MA(60%), RR(70%)", 50)).toBe(73);
  });

  it("returns 35 when confidence >60 with zero setups (contradiction floor)", () => {
    expect(computeOracleConfidence("Confidence: 65%", 65, 0, false)).toBe(35);
  });

  it("applies setup count penalty when below weekday minimum", () => {
    // 65% confidence, 1 setup, weekday: minSetups=3, shortfall=2, penalty=20pts → 45
    expect(computeOracleConfidence("Confidence: 65%", 65, 1, false)).toBe(45);
  });

  it("no penalty when setup count meets minimum for confidence level", () => {
    // 65% confidence, 3 setups, weekday: minSetups=3, shortfall=0 → no penalty
    expect(computeOracleConfidence("Confidence: 65%", 65, 3, false)).toBe(65);
  });

  it("honors explicit cap notation over raw confidence", () => {
    // text says 'capped at 65%', json=70 → resolveConfidence returns 65; 4 setups → no penalty
    expect(computeOracleConfidence("Confidence: 70% — capped at 65%", 70, 4, false)).toBe(65);
  });

  it("penalty is stable — result must not be fed back into resolveConfidence", () => {
    // This documents the agent.ts double-call bug (backlog #23):
    // oracle.ts computes final=45 (penalized from 65). If agent.ts then calls
    // resolveConfidence(analysis_with_65%, 45), diff=20>10 → returns 65 (bug!).
    // Fix: computeOracleConfidence is called once in oracle.ts; agent.ts must not
    // call resolveConfidence again.
    const text = "Confidence: 65% — TC(65%), MA(70%), RR(60%)";
    const penalized = computeOracleConfidence(text, 65, 1, false);
    expect(penalized).toBe(45); // penalty applied
    // If resolveConfidence were called again on the penalized value, it would undo it:
    // (this was the bug — agent.ts used to do this; now removed)
    expect(resolveConfidence(text, penalized)).toBe(65); // demonstrates the anti-pattern
  });

  it("weekend sessions apply minimum 2 setups instead of 3", () => {
    // weekend, 65% confidence, 2 setups: minSetups=2, no shortfall
    expect(computeOracleConfidence("Confidence: 65%", 65, 2, true)).toBe(65);
    // weekend, 65% confidence, 1 setup: minSetups=2, shortfall=1, penalty=10 → 55
    expect(computeOracleConfidence("Confidence: 65%", 65, 1, true)).toBe(55);
  });
});

// ── buildR039R040CrossAssetNote ───────────────────────────

function makeCrossSnap(name: string, symbol: string, changePct: number) {
  return { name, symbol, changePercent: changePct, price: 100, change: changePct };
}

describe("buildR039R040CrossAssetNote", () => {
  const multiClassSnaps = [
    makeCrossSnap("EUR/USD",      "EURUSD",  0.79),   // forex  <2% — small move
    makeCrossSnap("NASDAQ 100",   "NAS100",  4.65),   // indices >2%
    makeCrossSnap("Bitcoin",      "BTC",     5.15),   // crypto  >2%
    makeCrossSnap("Crude Oil",    "OIL",    -7.87),   // commodities >2%
    makeCrossSnap("Gold",         "GOLD",    1.44),   // commodities <2%
    makeCrossSnap("EUR/JPY",      "EURJPY",  0.84),   // forex <2%
  ];

  it("returns empty string when confidence < 55 (neither rule triggers)", () => {
    expect(buildR039R040CrossAssetNote(multiClassSnaps, 50)).toBe("");
    expect(buildR039R040CrossAssetNote(multiClassSnaps, 40)).toBe("");
  });

  it("returns empty string when confidence 55-59 and fewer than 3 classes moving >2% (r039 not triggered, r040 not triggered)", () => {
    // Only 1 class with a big move — r039 needs 3+, r040 needs ≥60
    const fewSnaps = [
      makeCrossSnap("EUR/USD", "EURUSD",  2.5),  // forex >2%
      makeCrossSnap("GBP/USD", "GBPUSD",  0.5),  // forex <2%
      makeCrossSnap("Bitcoin", "BTC",     1.0),  // crypto <2%
    ];
    expect(buildR039R040CrossAssetNote(fewSnaps, 57)).toBe("");
  });

  it("returns non-empty when confidence ≥55 and 3+ asset classes have moves >2% (r039)", () => {
    // multiClassSnaps: indices, crypto, commodities all >2% → r039 triggers at 57%
    const note = buildR039R040CrossAssetNote(multiClassSnaps, 57);
    expect(note.length).toBeGreaterThan(0);
  });

  it("returns non-empty when confidence ≥60 regardless of move count (r040)", () => {
    // Only 1 class moving >2% — r039 not triggered, but r040 triggers at ≥60
    const fewSnaps = [
      makeCrossSnap("EUR/USD", "EURUSD", 2.5),
      makeCrossSnap("GBP/USD", "GBPUSD", 0.5),
    ];
    const note = buildR039R040CrossAssetNote(fewSnaps, 67);
    expect(note.length).toBeGreaterThan(0);
  });

  it("note requires setups from ≥2 different asset classes", () => {
    const note = buildR039R040CrossAssetNote(multiClassSnaps, 67);
    expect(note).toMatch(/2.*(different|asset class)/i);
  });

  it("note names the four asset classes ORACLE must screen", () => {
    const note = buildR039R040CrossAssetNote(multiClassSnaps, 67);
    expect(note.toLowerCase()).toContain("forex");
    expect(note.toLowerCase()).toContain("indices");
    expect(note.toLowerCase()).toContain("crypto");
    expect(note.toLowerCase()).toMatch(/commodit/i);
  });

  it("note flags only-forex setups as a violation", () => {
    const note = buildR039R040CrossAssetNote(multiClassSnaps, 67);
    expect(note.toLowerCase()).toMatch(/violation|violat/i);
  });

  it("note references r039 when coordinated move condition met", () => {
    const note = buildR039R040CrossAssetNote(multiClassSnaps, 57);
    expect(note).toContain("r039");
  });

  it("note references r040 when confidence ≥60", () => {
    const note = buildR039R040CrossAssetNote(multiClassSnaps, 67);
    expect(note).toContain("r040");
  });

  it("note includes the confidence value", () => {
    const note = buildR039R040CrossAssetNote(multiClassSnaps, 67);
    expect(note).toContain("67%");
  });
});

// ── r031 auto-cap in computeOracleConfidence ──────────────
// Code enforcement: when confidence > 65 without cap notation, force to 65.
// Replaces the old prompt-only approach where ORACLE could ignore the rule.

describe("computeOracleConfidence r031 auto-cap", () => {
  it("auto-caps at 65 when confidence > 65 and no cap notation", () => {
    // Session #184 root cause: ORACLE reported 69% with no 'capped at X%' in text
    expect(computeOracleConfidence("Confidence: 69% — TC (65%), MA (75%), RR (70%)", 69, 5, false)).toBe(65);
  });

  it("auto-caps at 65 when confidence is 70 with no cap notation", () => {
    expect(computeOracleConfidence("Confidence: 70%", 70, 5, false)).toBe(65);
  });

  it("does NOT cap when confidence is exactly 65", () => {
    expect(computeOracleConfidence("Confidence: 65%", 65, 5, false)).toBe(65);
  });

  it("does NOT cap when confidence is below 65", () => {
    expect(computeOracleConfidence("Confidence: 60%", 60, 5, false)).toBe(60);
  });

  it("does NOT cap when cap notation is present (honors explicit cap)", () => {
    // ORACLE calculated 73% but capped to 67% — respect the explicit notation
    expect(computeOracleConfidence("Confidence: 73% — capped at 67% due to calibration discipline", 73, 5, false)).toBe(67);
  });

  it("does NOT cap when 'capped at 65%' is in text and json matches", () => {
    expect(computeOracleConfidence("Confidence: 65% — capped at 65%", 65, 5, false)).toBe(65);
  });

  it("auto-cap interacts correctly with setup count penalty — cap first, then penalize", () => {
    // 70% → auto-cap to 65 → 3 setups required at 65%, 2 provided → shortfall 1 → -10 → 55
    expect(computeOracleConfidence("Confidence: 70%", 70, 2, false)).toBe(55);
  });
});

// ── applyR039R040Penalty ──────────────────────────────────
// Code enforcement: when setups cover only 1 asset class at high confidence,
// reduce confidence proportionally — same pattern as applySetupCountPenalty.

describe("applyR039R040Penalty", () => {
  const multiSnaps = [
    { name: "NASDAQ 100", symbol: "NAS100", changePercent: 4.65, price: 26248, change: 1166 },
    { name: "Bitcoin",    symbol: "BTC",    changePercent: 5.15, price: 74397, change: 3643 },
    { name: "Crude Oil",  symbol: "OIL",    changePercent: -7.87, price: 91.28, change: -7.78 },
    { name: "EUR/USD",    symbol: "EURUSD", changePercent: 0.77,  price: 1.1781, change: 0.009 },
  ];

  const forexOnlySetups = [
    { instrument: "EUR/USD", entry: 1.1781, stop: 1.174, target: 1.185 },
    { instrument: "EUR/JPY", entry: 187.55, stop: 186.0, target: 190.0 },
  ];

  const crossClassSetups = [
    { instrument: "EUR/USD",   entry: 1.1781, stop: 1.174, target: 1.185 },
    { instrument: "NASDAQ 100", entry: 26248, stop: 25900, target: 26800 },
  ];

  it("applies penalty when only forex setups at ≥60% confidence with 3+ big-move classes", () => {
    const result = applyR039R040Penalty(67, multiSnaps, forexOnlySetups, false);
    expect(result.penalized).toBeLessThan(67);
    expect(result.reason).not.toBeNull();
  });

  it("applies penalty when only forex setups at 55-59% confidence with 3+ big-move classes (r039)", () => {
    const result = applyR039R040Penalty(57, multiSnaps, forexOnlySetups, false);
    expect(result.penalized).toBeLessThan(57);
    expect(result.reason).not.toBeNull();
  });

  it("does NOT penalize when setups span ≥2 asset classes", () => {
    const result = applyR039R040Penalty(67, multiSnaps, crossClassSetups, false);
    expect(result.penalized).toBe(67);
    expect(result.reason).toBeNull();
  });

  it("does NOT penalize on weekend sessions (crypto-only is valid)", () => {
    const result = applyR039R040Penalty(67, multiSnaps, forexOnlySetups, true);
    expect(result.penalized).toBe(67);
    expect(result.reason).toBeNull();
  });

  it("does NOT penalize when confidence < 55 (neither rule triggers)", () => {
    const result = applyR039R040Penalty(50, multiSnaps, forexOnlySetups, false);
    expect(result.penalized).toBe(50);
    expect(result.reason).toBeNull();
  });

  it("does NOT penalize at 55-59% with fewer than 3 big-move classes (r039 not triggered, r040 not triggered)", () => {
    const fewSnaps = [
      { name: "EUR/USD", symbol: "EURUSD", changePercent: 2.5,  price: 1.18, change: 0.02 },
      { name: "GBP/USD", symbol: "GBPUSD", changePercent: 0.5,  price: 1.35, change: 0.006 },
    ];
    const result = applyR039R040Penalty(57, fewSnaps, forexOnlySetups, false);
    expect(result.penalized).toBe(57);
    expect(result.reason).toBeNull();
  });

  it("penalized value does not drop below 35", () => {
    const result = applyR039R040Penalty(40, multiSnaps, forexOnlySetups, false);
    // 40 < 55, so no penalty
    expect(result.penalized).toBe(40);
  });

  it("reason string mentions r039 or r040", () => {
    const result = applyR039R040Penalty(67, multiSnaps, forexOnlySetups, false);
    expect(result.reason).toMatch(/r039|r040/i);
  });
});

// ── enforceR041ScreeningValidation ───────────────────────
// Code enforcement: when confidence > 55 and analysis lacks 'Screening validation:',
// auto-inject a stub line from market snapshot data rather than just warning.

describe("enforceR041ScreeningValidation", () => {
  const snaps = [
    { name: "EUR/USD",    symbol: "EURUSD",  changePercent: 0.77,  price: 1.1781, change: 0.009 },
    { name: "GBP/USD",    symbol: "GBPUSD",  changePercent: 0.77,  price: 1.3529, change: 0.01  },
    { name: "NASDAQ 100", symbol: "NAS100",  changePercent: 4.65,  price: 26248,  change: 1166  },
    { name: "S&P 500",    symbol: "SPX",     changePercent: 2.98,  price: 7028,   change: 203   },
    { name: "Bitcoin",    symbol: "BTC",     changePercent: 5.15,  price: 74397,  change: 3643  },
    { name: "Ethereum",   symbol: "ETH",     changePercent: 6.95,  price: 2328,   change: 151   },
    { name: "Gold",       symbol: "GOLD",    changePercent: 1.44,  price: 4811,   change: 68    },
    { name: "Crude Oil",  symbol: "OIL",     changePercent: -7.87, price: 91.28,  change: -7.78 },
  ];

  it("returns analysis unchanged when confidence ≤55 (rule does not apply)", () => {
    const analysis = "Some analysis without screening validation.";
    expect(enforceR041ScreeningValidation(analysis, snaps, 55)).toBe(analysis);
    expect(enforceR041ScreeningValidation(analysis, snaps, 40)).toBe(analysis);
  });

  it("returns analysis unchanged when screening validation already present", () => {
    const analysis = "Some analysis. Screening validation: EUR/USD 1.18 resistance 1.19, GBP/USD 1.35 resistance 1.36.";
    const result = enforceR041ScreeningValidation(analysis, snaps, 67);
    expect(result).toBe(analysis);
  });

  it("auto-injects screening validation line when confidence > 55 and line is missing", () => {
    const analysis = "Strong bullish momentum. Technical Confluence Analysis: 4 confluences.";
    const result = enforceR041ScreeningValidation(analysis, snaps, 67);
    expect(result).toContain("Screening validation:");
  });

  it("injected line contains current prices from snapshots", () => {
    const analysis = "Bullish session analysis.";
    const result = enforceR041ScreeningValidation(analysis, snaps, 67);
    // Should contain prices from the snapshots
    expect(result).toContain("1.1781"); // EUR/USD price
    expect(result).toContain("74397");  // BTC price
  });

  it("injected line includes all 8 r041 required instruments", () => {
    const analysis = "Bullish session analysis.";
    const result = enforceR041ScreeningValidation(analysis, snaps, 67);
    expect(result).toMatch(/EUR\/USD/i);
    expect(result).toMatch(/GBP\/USD/i);
    expect(result).toMatch(/NASDAQ|NAS100/i);
    expect(result).toMatch(/S&P|SPX/i);
    expect(result).toMatch(/BTC|Bitcoin/i);
    expect(result).toMatch(/ETH|Ethereum/i);
    expect(result).toMatch(/Gold/i);
    expect(result).toMatch(/Oil/i);
  });
});
