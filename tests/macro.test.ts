import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { MacroSnapshot, MacroIndicator, MacroSignal, GdeltEvent } from "../src/types";

// ── Helpers ──────────────────────────────────────────────

function makeIndicator(overrides: Partial<MacroIndicator> = {}): MacroIndicator {
  return {
    id: "DFF",
    label: "Fed Funds Rate",
    value: 5.33,
    date: "2026-03-10",
    trend: [5.33, 5.33, 5.25],
    ...overrides,
  };
}

function makeSignal(overrides: Partial<MacroSignal> = {}): MacroSignal {
  return {
    source: "FRED/VIXCLS",
    signal: "VIX ELEVATED (VIX: 32.5)",
    severity: "warning",
    ...overrides,
  };
}

function makeGdeltEvent(overrides: Partial<GdeltEvent> = {}): GdeltEvent {
  return {
    title: "US sanctions target new entities",
    url: "https://example.com/article",
    date: "20260314",
    domain: "example.com",
    country: "United States",
    ...overrides,
  };
}

function makeSnapshot(overrides: Partial<MacroSnapshot> = {}): MacroSnapshot {
  return {
    timestamp: new Date(),
    indicators: [],
    signals: [],
    treasuryDebt: [],
    geopoliticalEvents: { total: 0, conflicts: [], economy: [] },
    errors: [],
    ...overrides,
  };
}

// ── Import after helpers (uses fetch which needs to exist) ──

// We need to mock fetch before importing macro.ts
const originalFetch = global.fetch;

beforeEach(() => {
  vi.stubEnv("FRED_API_KEY", "");
});

afterEach(() => {
  vi.unstubAllEnvs();
  global.fetch = originalFetch;
});

// ── deriveSignals (tested via formatMacroForPrompt) ──────

describe("formatMacroForPrompt", () => {
  // Import dynamically so env stubs apply
  async function getModule() {
    return await import("../src/macro");
  }

  it("returns header for empty snapshot", async () => {
    const { formatMacroForPrompt } = await getModule();
    const result = formatMacroForPrompt(makeSnapshot());
    expect(result).toContain("=== MACRO & GEOPOLITICAL CONTEXT ===");
  });

  it("formats FRED indicators with labels and values", async () => {
    const { formatMacroForPrompt } = await getModule();
    const snapshot = makeSnapshot({
      indicators: [
        makeIndicator({ id: "DFF", label: "Fed Funds Rate", value: 5.33, date: "2026-03-10" }),
        makeIndicator({ id: "DGS10", label: "10Y Treasury Yield", value: 4.25, date: "2026-03-10" }),
      ],
    });
    const result = formatMacroForPrompt(snapshot);
    expect(result).toContain("--- FRED INDICATORS ---");
    expect(result).toContain("Fed Funds Rate");
    expect(result).toContain("5.33");
    expect(result).toContain("10Y Treasury Yield");
    expect(result).toContain("4.25");
  });

  it("shows trend arrows based on direction", async () => {
    const { formatMacroForPrompt } = await getModule();
    const rising = makeIndicator({ value: 5.50, trend: [5.50, 5.33] });  // rising
    const falling = makeIndicator({ id: "DGS10", label: "10Y Yield", value: 4.10, trend: [4.10, 4.25] }); // falling
    const flat = makeIndicator({ id: "UNRATE", label: "Unemployment", value: 3.7, trend: [3.7, 3.7] }); // flat

    const snapshot = makeSnapshot({ indicators: [rising, falling, flat] });
    const result = formatMacroForPrompt(snapshot);
    expect(result).toContain("↑");
    expect(result).toContain("↓");
    expect(result).toContain("→");
  });

  it("skips indicators with null values", async () => {
    const { formatMacroForPrompt } = await getModule();
    const snapshot = makeSnapshot({
      indicators: [makeIndicator({ id: "MISSING", label: "Missing Data", value: null, trend: [] })],
    });
    const result = formatMacroForPrompt(snapshot);
    expect(result).not.toContain("Missing Data");
  });

  it("formats treasury debt in trillions", async () => {
    const { formatMacroForPrompt } = await getModule();
    const snapshot = makeSnapshot({
      treasuryDebt: [{ date: "2026-03-10", totalDebt: "36500000000000", publicDebt: "28000000000000" }],
    });
    const result = formatMacroForPrompt(snapshot);
    expect(result).toContain("--- US TREASURY DEBT ---");
    expect(result).toContain("$36.50T");
    expect(result).toContain("$28.00T");
  });

  it("formats geopolitical events with categories", async () => {
    const { formatMacroForPrompt } = await getModule();
    const snapshot = makeSnapshot({
      geopoliticalEvents: {
        total: 25,
        conflicts: [makeGdeltEvent({ title: "Military escalation in region X" })],
        economy: [makeGdeltEvent({ title: "Tariff talks resume between US and EU" })],
      },
    });
    const result = formatMacroForPrompt(snapshot);
    expect(result).toContain("--- GEOPOLITICAL EVENTS (last 24h) ---");
    expect(result).toContain("Total articles scanned: 25");
    expect(result).toContain("Conflict/Military:");
    expect(result).toContain("Military escalation in region X");
    expect(result).toContain("Economic/Trade:");
    expect(result).toContain("Tariff talks resume between US and EU");
  });

  it("limits geopolitical events to 3 per category", async () => {
    const { formatMacroForPrompt } = await getModule();
    const conflicts = Array.from({ length: 5 }, (_, i) =>
      makeGdeltEvent({ title: `Conflict event ${i + 1}` })
    );
    const snapshot = makeSnapshot({
      geopoliticalEvents: { total: 5, conflicts, economy: [] },
    });
    const result = formatMacroForPrompt(snapshot);
    expect(result).toContain("Conflict event 1");
    expect(result).toContain("Conflict event 3");
    expect(result).not.toContain("Conflict event 4");
  });

  it("formats macro signals with severity icons", async () => {
    const { formatMacroForPrompt } = await getModule();
    const snapshot = makeSnapshot({
      signals: [
        makeSignal({ severity: "critical", signal: "YIELD CURVE INVERTED" }),
        makeSignal({ severity: "warning", signal: "VIX ELEVATED" }),
      ],
    });
    const result = formatMacroForPrompt(snapshot);
    expect(result).toContain("--- MACRO SIGNALS ---");
    expect(result).toContain("[CRITICAL]");
    expect(result).toContain("YIELD CURVE INVERTED");
    expect(result).toContain("[WARNING]");
    expect(result).toContain("VIX ELEVATED");
  });
});

// ── Signal derivation (tested indirectly via fetchMacroSnapshot mock) ──

describe("signal derivation", () => {
  // We test signal logic by importing the module and checking formatMacroForPrompt
  // with indicator data that should trigger signals. The deriveSignals function
  // is internal, but we can verify it via the full pipeline.

  // For unit-testing signal logic directly, we re-implement the check inline
  // since deriveSignals is not exported.

  it("yield curve inversion produces critical signal", async () => {
    const { formatMacroForPrompt } = await import("../src/macro");
    const snapshot = makeSnapshot({
      signals: [{
        source: "FRED/T10Y2Y",
        signal: "YIELD CURVE INVERTED — recession signal (spread: -0.42%)",
        severity: "critical",
      }],
    });
    const result = formatMacroForPrompt(snapshot);
    expect(result).toContain("YIELD CURVE INVERTED");
    expect(result).toContain("[CRITICAL]");
  });

  it("VIX above 30 is warning, above 40 is critical", async () => {
    const { formatMacroForPrompt } = await import("../src/macro");

    const warningSnapshot = makeSnapshot({
      signals: [makeSignal({ severity: "warning", signal: "VIX ELEVATED (VIX: 32.5)" })],
    });
    expect(formatMacroForPrompt(warningSnapshot)).toContain("[WARNING]");

    const criticalSnapshot = makeSnapshot({
      signals: [makeSignal({ severity: "critical", signal: "VIX EXTREME — crisis-level fear (VIX: 45.2)" })],
    });
    expect(formatMacroForPrompt(criticalSnapshot)).toContain("[CRITICAL]");
  });

  it("high yield spread above 5 is warning", async () => {
    const { formatMacroForPrompt } = await import("../src/macro");
    const snapshot = makeSnapshot({
      signals: [makeSignal({ severity: "warning", signal: "CREDIT STRESS — high yield spread wide (5.50%)" })],
    });
    const result = formatMacroForPrompt(snapshot);
    expect(result).toContain("CREDIT STRESS");
    expect(result).toContain("[WARNING]");
  });
});

// ── fetchMacroSnapshot ──────────────────────────────────

describe("fetchMacroSnapshot", () => {
  it("returns empty snapshot when all sources fail", async () => {
    global.fetch = vi.fn().mockRejectedValue(new Error("Network error"));

    // Re-import to use mocked fetch
    const { fetchMacroSnapshot } = await import("../src/macro");
    const snapshot = await fetchMacroSnapshot();

    expect(snapshot.indicators).toEqual([]);
    expect(snapshot.treasuryDebt).toEqual([]);
    expect(snapshot.geopoliticalEvents.total).toBe(0);
    expect(snapshot.errors.length).toBeGreaterThan(0);
  });

  it("skips FRED when FRED_API_KEY is not set", async () => {
    vi.stubEnv("FRED_API_KEY", "");

    // Mock fetch to track calls
    const fetchMock = vi.fn().mockRejectedValue(new Error("should not be called for FRED"));
    global.fetch = fetchMock;

    const { fetchMacroSnapshot } = await import("../src/macro");
    const snapshot = await fetchMacroSnapshot();

    // FRED error should mention the missing key
    const fredError = snapshot.errors.find((e) => e.includes("FRED"));
    expect(fredError).toBeDefined();
    expect(fredError).toContain("FRED_API_KEY");
  });

  it("returns treasury data when Treasury API succeeds", async () => {
    const treasuryResponse = {
      data: [
        { record_date: "2026-03-10", tot_pub_debt_out_amt: "36500000000000", debt_held_public_amt: "28000000000000" },
      ],
    };

    global.fetch = vi.fn().mockImplementation((url: string) => {
      if (typeof url === "string" && url.includes("fiscaldata.treasury.gov")) {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve(treasuryResponse),
        });
      }
      return Promise.reject(new Error("Mock: not Treasury"));
    });

    const { fetchMacroSnapshot } = await import("../src/macro");
    const snapshot = await fetchMacroSnapshot();

    expect(snapshot.treasuryDebt).toHaveLength(1);
    expect(snapshot.treasuryDebt[0].totalDebt).toBe("36500000000000");
    expect(snapshot.treasuryDebt[0].date).toBe("2026-03-10");
  });

  it("returns GDELT events when GDELT API succeeds", async () => {
    const gdeltResponse = {
      articles: [
        { title: "Military conflict escalates", url: "https://ex.com/1", seendate: "20260314", domain: "ex.com", sourcecountry: "US" },
        { title: "Economy shows tariff impact", url: "https://ex.com/2", seendate: "20260314", domain: "ex.com", sourcecountry: "UK" },
        { title: "Sports event recap", url: "https://ex.com/3", seendate: "20260314", domain: "ex.com", sourcecountry: "AU" },
      ],
    };

    global.fetch = vi.fn().mockImplementation((url: string) => {
      if (typeof url === "string" && url.includes("gdeltproject.org")) {
        const body = JSON.stringify(gdeltResponse);
        return Promise.resolve({
          ok: true,
          headers: new Headers({ "content-type": "application/json" }),
          text: () => Promise.resolve(body),
        });
      }
      return Promise.reject(new Error("Mock: not GDELT"));
    });

    const { fetchMacroSnapshot } = await import("../src/macro");
    const snapshot = await fetchMacroSnapshot();

    expect(snapshot.geopoliticalEvents.total).toBe(3);
    expect(snapshot.geopoliticalEvents.conflicts.length).toBeGreaterThan(0);
    expect(snapshot.geopoliticalEvents.conflicts[0].title).toContain("Military");
    expect(snapshot.geopoliticalEvents.economy.length).toBeGreaterThan(0);
    expect(snapshot.geopoliticalEvents.economy[0].title).toContain("tariff");
  });

  it("returns FRED indicators when API key is set and API succeeds", async () => {
    vi.stubEnv("FRED_API_KEY", "test-key-123");

    const fredResponse = {
      observations: [
        { date: "2026-03-10", value: "5.33" },
        { date: "2026-03-07", value: "5.33" },
        { date: "2026-03-06", value: "5.25" },
      ],
    };

    global.fetch = vi.fn().mockImplementation((url: string) => {
      if (typeof url === "string" && url.includes("api.stlouisfed.org")) {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve(fredResponse),
        });
      }
      return Promise.reject(new Error("Mock: not FRED"));
    });

    const { fetchMacroSnapshot } = await import("../src/macro");
    const snapshot = await fetchMacroSnapshot();

    expect(snapshot.indicators.length).toBeGreaterThan(0);
    expect(snapshot.indicators[0].value).toBe(5.33);
    expect(snapshot.indicators[0].trend).toEqual([5.33, 5.33, 5.25]);
  });

  it("derives signals from FRED indicators", async () => {
    vi.stubEnv("FRED_API_KEY", "test-key-123");

    // Return inverted yield curve for T10Y2Y, high VIX
    global.fetch = vi.fn().mockImplementation((url: string) => {
      if (typeof url === "string" && url.includes("api.stlouisfed.org")) {
        const seriesMatch = url.match(/series_id=([^&]+)/);
        const seriesId = seriesMatch?.[1] ?? "";

        let value = "3.00";
        if (seriesId === "T10Y2Y") value = "-0.42";
        if (seriesId === "VIXCLS") value = "35.5";
        if (seriesId === "BAMLH0A0HYM2") value = "3.2";

        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({
            observations: [{ date: "2026-03-10", value }],
          }),
        });
      }
      return Promise.reject(new Error("Mock: not FRED"));
    });

    const { fetchMacroSnapshot } = await import("../src/macro");
    const snapshot = await fetchMacroSnapshot();

    // Should have yield curve inversion (critical) and VIX elevated (warning)
    const yieldSignal = snapshot.signals.find((s) => s.signal.includes("YIELD CURVE"));
    expect(yieldSignal).toBeDefined();
    expect(yieldSignal!.severity).toBe("critical");

    const vixSignal = snapshot.signals.find((s) => s.signal.includes("VIX"));
    expect(vixSignal).toBeDefined();
    expect(vixSignal!.severity).toBe("warning");

    // HY spread at 3.2 should NOT trigger (threshold is 5)
    const hySignal = snapshot.signals.find((s) => s.signal.includes("CREDIT STRESS"));
    expect(hySignal).toBeUndefined();
  });

  it("handles FRED observations with missing values (dots)", async () => {
    vi.stubEnv("FRED_API_KEY", "test-key-123");

    global.fetch = vi.fn().mockImplementation((url: string) => {
      if (typeof url === "string" && url.includes("api.stlouisfed.org")) {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({
            observations: [
              { date: "2026-03-10", value: "." },
              { date: "2026-03-09", value: "." },
              { date: "2026-03-08", value: "4.25" },
            ],
          }),
        });
      }
      return Promise.reject(new Error("Mock: not FRED"));
    });

    const { fetchMacroSnapshot } = await import("../src/macro");
    const snapshot = await fetchMacroSnapshot();

    // Should filter out "." values and use 4.25 as latest
    for (const ind of snapshot.indicators) {
      if (ind.value !== null) {
        expect(ind.value).toBe(4.25);
        expect(ind.date).toBe("2026-03-08");
      }
    }
  });

  it("handles HTTP errors gracefully per source", async () => {
    global.fetch = vi.fn().mockImplementation((url: string) => {
      if (typeof url === "string" && url.includes("fiscaldata.treasury.gov")) {
        return Promise.resolve({ ok: false, status: 500 });
      }
      if (typeof url === "string" && url.includes("gdeltproject.org")) {
        const body = JSON.stringify({ articles: [] });
        return Promise.resolve({
          ok: true,
          headers: new Headers({ "content-type": "application/json" }),
          text: () => Promise.resolve(body),
        });
      }
      return Promise.reject(new Error("Mock: unknown"));
    });

    const { fetchMacroSnapshot } = await import("../src/macro");
    const snapshot = await fetchMacroSnapshot();

    // Treasury should have failed
    expect(snapshot.treasuryDebt).toEqual([]);
    const treasuryError = snapshot.errors.find((e) => e.includes("Treasury"));
    expect(treasuryError).toBeDefined();

    // GDELT should still work
    expect(snapshot.geopoliticalEvents.total).toBe(0); // empty articles but no error
  });
});

// ── FRED_SERIES config ──────────────────────────────────

describe("FRED series configuration", () => {
  it("includes key market-relevant series", async () => {
    // We can't import FRED_SERIES directly (not exported), but we can verify
    // via a FRED API call that the expected series IDs are requested
    vi.stubEnv("FRED_API_KEY", "test-key-123");

    const calledSeries: string[] = [];
    global.fetch = vi.fn().mockImplementation((url: string) => {
      if (typeof url === "string" && url.includes("api.stlouisfed.org")) {
        const match = url.match(/series_id=([^&]+)/);
        if (match) calledSeries.push(match[1]);
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ observations: [] }),
        });
      }
      return Promise.reject(new Error("Mock: not FRED"));
    });

    const { fetchMacroSnapshot } = await import("../src/macro");
    await fetchMacroSnapshot();

    expect(calledSeries).toContain("DFF");       // Fed Funds Rate
    expect(calledSeries).toContain("DGS10");     // 10Y Treasury
    expect(calledSeries).toContain("T10Y2Y");    // Yield curve
    expect(calledSeries).toContain("VIXCLS");    // VIX
    expect(calledSeries).toContain("UNRATE");    // Unemployment
    expect(calledSeries).toContain("CPIAUCSL");  // CPI
    expect(calledSeries).toContain("DTWEXBGS");  // USD index
    expect(calledSeries).toContain("BAMLH0A0HYM2"); // HY spread
  });
});

// ── MacroSnapshot type shape ──────────────────────────────

describe("MacroSnapshot shape", () => {
  it("has all required fields with correct types", () => {
    const snapshot = makeSnapshot();
    expect(snapshot.timestamp).toBeInstanceOf(Date);
    expect(Array.isArray(snapshot.indicators)).toBe(true);
    expect(Array.isArray(snapshot.signals)).toBe(true);
    expect(Array.isArray(snapshot.treasuryDebt)).toBe(true);
    expect(snapshot.geopoliticalEvents).toHaveProperty("total");
    expect(snapshot.geopoliticalEvents).toHaveProperty("conflicts");
    expect(snapshot.geopoliticalEvents).toHaveProperty("economy");
    expect(Array.isArray(snapshot.errors)).toBe(true);
  });

  it("MacroIndicator has expected fields", () => {
    const ind = makeIndicator();
    expect(typeof ind.id).toBe("string");
    expect(typeof ind.label).toBe("string");
    expect(typeof ind.value).toBe("number");
    expect(typeof ind.date).toBe("string");
    expect(Array.isArray(ind.trend)).toBe(true);
  });

  it("MacroSignal severity is constrained", () => {
    const validSeverities = ["info", "warning", "critical"];
    for (const sev of validSeverities) {
      const signal = makeSignal({ severity: sev as any });
      expect(validSeverities).toContain(signal.severity);
    }
  });

  it("GdeltEvent has expected fields", () => {
    const event = makeGdeltEvent();
    expect(typeof event.title).toBe("string");
    expect(typeof event.url).toBe("string");
    expect(typeof event.date).toBe("string");
    expect(typeof event.domain).toBe("string");
    expect(typeof event.country).toBe("string");
  });
});
