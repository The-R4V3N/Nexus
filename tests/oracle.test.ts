import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// We'll test the R:R warning by importing runOracleAnalysis indirectly.
// Since the warning is logged via console.warn in the setup filtering section,
// we test it by verifying the warning is emitted for setups with RR < 1.0.

// The warning logic is inside runOracleAnalysis which requires API calls,
// so we extract and test the warning behavior by importing and calling
// the function that processes setups. Since the warning is inline in
// runOracleAnalysis, we'll need to test it via a focused unit approach.

// For now, we test the exported warnPoorRiskReward helper.
describe("warnPoorRiskReward", () => {
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    warnSpy.mockRestore();
  });

  it("logs warning for setup with RR < 1.0", async () => {
    const { warnPoorRiskReward } = await import("../src/oracle");
    const setups = [
      { instrument: "EUR/USD", RR: 0.5, entry: 1.08, stop: 1.07, target: 1.085, timeframe: "4H" },
    ];
    warnPoorRiskReward(setups);
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("poor risk/reward")
    );
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("RR=0.50")
    );
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("EUR/USD")
    );
  });

  it("does not log warning for setup with RR >= 1.0", async () => {
    const { warnPoorRiskReward } = await import("../src/oracle");
    const setups = [
      { instrument: "EUR/USD", RR: 1.5, entry: 1.08, stop: 1.07, target: 1.095, timeframe: "4H" },
    ];
    warnPoorRiskReward(setups);
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it("does not log warning when RR is exactly 1.0", async () => {
    const { warnPoorRiskReward } = await import("../src/oracle");
    const setups = [
      { instrument: "GBP/USD", RR: 1.0, entry: 1.25, stop: 1.24, target: 1.26, timeframe: "1H" },
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
