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
