// ============================================================
// NEXUS — Market Data Module
// Fetches data from Yahoo Finance v8 API (no package needed)
// ============================================================

import chalk from "chalk";
import * as fs from "fs";
import * as path from "path";
import { groupBy } from "./utils";
import type { MarketConfig, MarketSnapshot } from "./types";

// ── Instrument Registry ────────────────────────────────────

const DEFAULT_CONFIGS: MarketConfig[] = [
  { symbol: "EURUSD=X", name: "EUR/USD", category: "forex" },
  { symbol: "GBPUSD=X", name: "GBP/USD", category: "forex" },
  { symbol: "USDJPY=X", name: "USD/JPY", category: "forex" },
  { symbol: "USDCHF=X", name: "USD/CHF", category: "forex" },
  { symbol: "AUDUSD=X", name: "AUD/USD", category: "forex" },
  { symbol: "USDCAD=X", name: "USD/CAD", category: "forex" },
  { symbol: "NZDUSD=X", name: "NZD/USD", category: "forex" },
  { symbol: "^NDX", name: "NASDAQ 100", category: "indices" },
  { symbol: "^GSPC", name: "S&P 500", category: "indices" },
  { symbol: "BTC-USD", name: "Bitcoin", category: "crypto" },
  { symbol: "ETH-USD", name: "Ethereum", category: "crypto" },
  { symbol: "GC=F", name: "Gold", category: "commodities" },
  { symbol: "CL=F", name: "Crude Oil", category: "commodities" },
];

const CONFIG_FILES = ["forex.json", "indices.json", "crypto.json", "commodities.json"];

function loadMarketConfigs(): MarketConfig[] {
  try {
    const configDir = path.join(process.cwd(), "config");
    const configs: MarketConfig[] = [];
    for (const file of CONFIG_FILES) {
      const filePath = path.join(configDir, file);
      if (fs.existsSync(filePath)) {
        const items: MarketConfig[] = JSON.parse(fs.readFileSync(filePath, "utf-8"));
        configs.push(...items);
      }
    }
    if (configs.length > 0) return configs;
  } catch {
    // Fall through to default
  }
  return DEFAULT_CONFIGS;
}

export const MARKET_CONFIGS: MarketConfig[] = loadMarketConfigs();

// ── Yahoo Finance v8 fetch ─────────────────────────────────

async function fetchYahooQuote(symbol: string): Promise<any> {
  const encoded = encodeURIComponent(symbol);
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encoded}?interval=1d&range=5d`;
  const res = await fetch(url, {
    headers: { "User-Agent": "Mozilla/5.0", "Accept": "application/json" },
    signal: AbortSignal.timeout(10000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const data = await res.json() as any;
  return data?.chart?.result?.[0] ?? null;
}

export async function fetchMarketSnapshot(config: MarketConfig): Promise<MarketSnapshot | null> {
  try {
    const result = await fetchYahooQuote(config.symbol);
    if (!result) return null;
    const meta = result.meta;
    const price = meta.regularMarketPrice ?? 0;
    const previousClose = meta.chartPreviousClose ?? meta.previousClose ?? price;
    const change = price - previousClose;
    const changePercent = previousClose !== 0 ? (change / previousClose) * 100 : 0;

    // Extract close prices from the chart data for rolling average
    const closes: number[] = result.indicators?.quote?.[0]?.close?.filter((c: any) => c != null) ?? [];
    const avgChange = closes.length >= 2
      ? closes.slice(1).reduce((sum: number, c: number, i: number) => sum + Math.abs((c - closes[i]) / closes[i] * 100), 0) / (closes.length - 1)
      : 0;

    return {
      symbol: config.symbol, name: config.name, category: config.category,
      price, previousClose, change, changePercent,
      high: meta.regularMarketDayHigh ?? price,
      low: meta.regularMarketDayLow ?? price,
      avgDailyChange: avgChange,
      timestamp: new Date(),
    };
  } catch (err) {
    console.warn(chalk.yellow(`  ⚠ Could not fetch ${config.name}: ${err}`));
    return null;
  }
}

export async function fetchAllMarkets(): Promise<MarketSnapshot[]> {
  const results = await Promise.allSettled(MARKET_CONFIGS.map((c) => fetchMarketSnapshot(c)));
  const snapshots: MarketSnapshot[] = [];
  for (const r of results) {
    if (r.status === "fulfilled" && r.value !== null) snapshots.push(r.value);
  }
  return snapshots;
}

export function formatSnapshotsForPrompt(snapshots: MarketSnapshot[]): string {
  const byCategory = groupBy(snapshots, (s) => s.category);
  const lines: string[] = ["=== CURRENT MARKET DATA ===\n"];
  for (const [category, items] of Object.entries(byCategory)) {
    lines.push(`--- ${category.toUpperCase()} ---`);
    for (const s of items) {
      const sign = s.change >= 0 ? "+" : "";
      const pct = s.changePercent.toFixed(2);
      const price = s.price < 10 ? s.price.toFixed(5) : s.price.toFixed(2);
      const isExceptional = s.avgDailyChange && Math.abs(s.changePercent) > s.avgDailyChange * 2;
      const avgNote = isExceptional ? ` [>2x avg move]` : "";
      lines.push(`${s.name.padEnd(14)} ${price.padStart(12)}  ${sign}${s.change.toFixed(4)} (${sign}${pct}%)  H:${s.high.toFixed(2)} L:${s.low.toFixed(2)}${avgNote}`);
    }
    lines.push("");
  }
  return lines.join("\n");
}

export function printMarketsTable(snapshots: MarketSnapshot[]): void {
  const byCategory = groupBy(snapshots, (s) => s.category);
  for (const [category, items] of Object.entries(byCategory)) {
    console.log(chalk.dim(`\n  ── ${category.toUpperCase()} ──`));
    for (const s of items) {
      const up = s.change >= 0;
      const sign = up ? "+" : "";
      const pct = s.changePercent.toFixed(2);
      const price = s.price < 10 ? s.price.toFixed(5) : s.price.toFixed(2);
      const changeStr = chalk[up ? "green" : "red"](`${sign}${pct.padStart(6)}%`);
      console.log(`  ${chalk.white(s.name.padEnd(14))} ${chalk.cyan(price.padStart(12))}  ${changeStr}`);
    }
  }
  console.log("");
}