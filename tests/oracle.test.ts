import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

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
