import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { MarketSnapshot } from "../src/types";

// ── fetchCryptoMarkets export ────────────────────────────────

describe("crypto-markets module", () => {
  it("exports fetchCryptoMarkets", async () => {
    const mod = await import("../src/crypto-markets");
    expect(typeof mod.fetchCryptoMarkets).toBe("function");
  });

  it("exports CRYPTO_SYMBOL_MAP", async () => {
    const mod = await import("../src/crypto-markets");
    expect(typeof mod.CRYPTO_SYMBOL_MAP).toBe("object");
  });
});

// ── CRYPTO_SYMBOL_MAP ────────────────────────────────────────

describe("CRYPTO_SYMBOL_MAP", () => {
  it("maps all 10 crypto symbols to Binance format", async () => {
    const { CRYPTO_SYMBOL_MAP } = await import("../src/crypto-markets");
    expect(Object.keys(CRYPTO_SYMBOL_MAP)).toHaveLength(10);
    expect(CRYPTO_SYMBOL_MAP["BTC-USD"]).toBe("BTCUSDT");
    expect(CRYPTO_SYMBOL_MAP["ETH-USD"]).toBe("ETHUSDT");
    expect(CRYPTO_SYMBOL_MAP["SOL-USD"]).toBe("SOLUSDT");
    expect(CRYPTO_SYMBOL_MAP["XRP-USD"]).toBe("XRPUSDT");
    expect(CRYPTO_SYMBOL_MAP["BNB-USD"]).toBe("BNBUSDT");
    expect(CRYPTO_SYMBOL_MAP["ADA-USD"]).toBe("ADAUSDT");
    expect(CRYPTO_SYMBOL_MAP["DOGE-USD"]).toBe("DOGEUSDT");
    expect(CRYPTO_SYMBOL_MAP["AVAX-USD"]).toBe("AVAXUSDT");
    expect(CRYPTO_SYMBOL_MAP["DOT-USD"]).toBe("DOTUSDT");
    expect(CRYPTO_SYMBOL_MAP["LINK-USD"]).toBe("LINKUSDT");
  });
});

// ── fetchCryptoMarkets ───────────────────────────────────────

describe("fetchCryptoMarkets", () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    warnSpy.mockRestore();
    vi.restoreAllMocks();
    vi.resetModules();
  });

  function makeBinanceResponse(symbol: string, lastPrice: string, priceChangePercent: string) {
    return {
      symbol,
      lastPrice,
      priceChangePercent,
      highPrice: String(parseFloat(lastPrice) * 1.02),
      lowPrice: String(parseFloat(lastPrice) * 0.98),
      volume: "12345.67",
    };
  }

  it("maps Binance API response to MarketSnapshot correctly", async () => {
    const binanceData = makeBinanceResponse("BTCUSDT", "65000.50", "2.35");

    vi.stubGlobal("fetch", vi.fn(async () => ({
      ok: true,
      json: async () => binanceData,
    })));

    vi.doMock("fs", async () => {
      const actual = await vi.importActual<typeof import("fs")>("fs");
      return {
        ...actual,
        existsSync: (p: string) => {
          if (typeof p === "string" && p.includes("config")) return actual.existsSync(p);
          return actual.existsSync(p);
        },
      };
    });

    vi.resetModules();
    const { fetchCryptoMarkets } = await import("../src/crypto-markets");
    const snapshots = await fetchCryptoMarkets();

    // Should return snapshots for all crypto configs that succeeded
    expect(snapshots.length).toBeGreaterThan(0);

    const btc = snapshots.find(s => s.symbol === "BTC-USD");
    expect(btc).toBeDefined();
    expect(btc!.price).toBe(65000.50);
    expect(btc!.category).toBe("crypto");
    expect(btc!.changePercent).toBe(2.35);
    expect(btc!.name).toBe("Bitcoin");
    expect(btc!.timestamp).toBeInstanceOf(Date);
    expect(btc!.avgDailyChange).toBeUndefined();
  });

  it("fetches all 10 crypto symbols", async () => {
    const binanceData = makeBinanceResponse("BTCUSDT", "65000", "1.5");

    vi.stubGlobal("fetch", vi.fn(async () => ({
      ok: true,
      json: async () => binanceData,
    })));

    vi.resetModules();
    const { fetchCryptoMarkets } = await import("../src/crypto-markets");
    const snapshots = await fetchCryptoMarkets();

    expect(snapshots).toHaveLength(10);
  });

  it("all snapshots have category crypto", async () => {
    const binanceData = makeBinanceResponse("BTCUSDT", "65000", "1.5");

    vi.stubGlobal("fetch", vi.fn(async () => ({
      ok: true,
      json: async () => binanceData,
    })));

    vi.resetModules();
    const { fetchCryptoMarkets } = await import("../src/crypto-markets");
    const snapshots = await fetchCryptoMarkets();

    for (const snap of snapshots) {
      expect(snap.category).toBe("crypto");
    }
  });

  it("calculates previousClose from price and priceChangePercent", async () => {
    // price = 100, changePercent = 5 means previousClose = 100 / 1.05 = ~95.238
    const binanceData = makeBinanceResponse("BTCUSDT", "100", "5");

    vi.stubGlobal("fetch", vi.fn(async () => ({
      ok: true,
      json: async () => binanceData,
    })));

    vi.resetModules();
    const { fetchCryptoMarkets } = await import("../src/crypto-markets");
    const snapshots = await fetchCryptoMarkets();

    const btc = snapshots.find(s => s.symbol === "BTC-USD");
    expect(btc).toBeDefined();
    // previousClose = price / (1 + changePercent/100) = 100 / 1.05 ~= 95.238
    expect(btc!.previousClose).toBeCloseTo(95.238, 2);
    // change = price - previousClose
    expect(btc!.change).toBeCloseTo(100 - 95.238, 2);
  });

  it("handles Binance API error gracefully", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({
      ok: false,
      status: 500,
    })));

    vi.resetModules();
    const { fetchCryptoMarkets } = await import("../src/crypto-markets");
    const snapshots = await fetchCryptoMarkets();

    // Should return empty array when all fetches fail
    expect(snapshots).toHaveLength(0);
  });

  it("handles fetch throwing errors gracefully", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => {
      throw new Error("Network error");
    }));

    vi.resetModules();
    const { fetchCryptoMarkets } = await import("../src/crypto-markets");
    const snapshots = await fetchCryptoMarkets();

    expect(snapshots).toHaveLength(0);
  });

  it("continues fetching when some symbols fail", async () => {
    let callCount = 0;
    vi.stubGlobal("fetch", vi.fn(async () => {
      callCount++;
      if (callCount <= 3) {
        throw new Error("Network error");
      }
      return {
        ok: true,
        json: async () => makeBinanceResponse("BTCUSDT", "65000", "1.5"),
      };
    }));

    vi.resetModules();
    const { fetchCryptoMarkets } = await import("../src/crypto-markets");
    const snapshots = await fetchCryptoMarkets();

    // 3 fail, 7 succeed
    expect(snapshots).toHaveLength(7);
  });
});
