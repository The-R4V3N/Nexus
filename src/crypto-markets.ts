// ============================================================
// NEXUS — Crypto Market Data Module (Binance API)
// Fetches live crypto prices from Binance public API
// Used for weekend sessions when Yahoo Finance is stale
// ============================================================

import chalk from "chalk";
import * as fs from "fs";
import * as path from "path";
import type { MarketConfig, MarketSnapshot } from "./types";

// ── Binance symbol mapping ────────────────────────────────

export const CRYPTO_SYMBOL_MAP: Record<string, string> = {
  "BTC-USD": "BTCUSDT",
  "ETH-USD": "ETHUSDT",
  "SOL-USD": "SOLUSDT",
  "XRP-USD": "XRPUSDT",
  "BNB-USD": "BNBUSDT",
  "ADA-USD": "ADAUSDT",
  "DOGE-USD": "DOGEUSDT",
  "AVAX-USD": "AVAXUSDT",
  "DOT-USD": "DOTUSDT",
  "LINK-USD": "LINKUSDT",
};

// ── Load crypto configs ───────────────────────────────────

function loadCryptoConfigs(): MarketConfig[] {
  try {
    const configPath = path.join(process.cwd(), "config", "crypto.json");
    if (fs.existsSync(configPath)) {
      return JSON.parse(fs.readFileSync(configPath, "utf-8"));
    }
  } catch {
    // Fall through to default
  }
  return [
    { symbol: "BTC-USD", name: "Bitcoin", category: "crypto" },
    { symbol: "ETH-USD", name: "Ethereum", category: "crypto" },
  ];
}

// ── Binance API fetch ─────────────────────────────────────

async function fetchBinanceTicker(binanceSymbol: string): Promise<any> {
  const url = `https://api.binance.com/api/v3/ticker/24hr?symbol=${binanceSymbol}`;
  const res = await fetch(url, {
    headers: { "Accept": "application/json" },
    signal: AbortSignal.timeout(10000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return await res.json();
}

// ── Main export ───────────────────────────────────────────

export async function fetchCryptoMarkets(): Promise<MarketSnapshot[]> {
  const configs = loadCryptoConfigs();

  const results = await Promise.allSettled(
    configs.map(async (config): Promise<MarketSnapshot | null> => {
      const binanceSymbol = CRYPTO_SYMBOL_MAP[config.symbol];
      if (!binanceSymbol) {
        console.warn(chalk.yellow(`  \u26a0 No Binance mapping for ${config.symbol}`));
        return null;
      }

      try {
        const data = await fetchBinanceTicker(binanceSymbol);

        const price = parseFloat(data.lastPrice);
        const changePercent = parseFloat(data.priceChangePercent);
        const previousClose = price / (1 + changePercent / 100);
        const change = price - previousClose;

        return {
          symbol: config.symbol,
          name: config.name,
          category: "crypto",
          price,
          previousClose,
          change,
          changePercent,
          high: parseFloat(data.highPrice),
          low: parseFloat(data.lowPrice),
          avgDailyChange: undefined,
          timestamp: new Date(),
        };
      } catch (err) {
        console.warn(chalk.yellow(`  \u26a0 Could not fetch ${config.name} from Binance: ${err}`));
        return null;
      }
    })
  );

  const snapshots: MarketSnapshot[] = [];
  for (const r of results) {
    if (r.status === "fulfilled" && r.value !== null) {
      snapshots.push(r.value);
    }
  }
  return snapshots;
}
