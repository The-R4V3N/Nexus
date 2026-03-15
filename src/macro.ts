// ============================================================
// NEXUS — Macro & Geopolitical Data Module
// Fetches FRED indicators, US Treasury debt, and GDELT events
// ============================================================

import chalk from "chalk";
import { INJECTION_PATTERNS } from "./security";
import type { MacroSnapshot, MacroIndicator, MacroSignal, GdeltEvent, AlphaVantageData, AlphaTechnical } from "./types";

// ── Macro text sanitization ──────────────────────────────

export function sanitizeMacroText(text: string): string {
  if (!text) return text;

  // Truncate to 200 chars
  let cleaned = text.slice(0, 200);

  // Strip HTML tags
  cleaned = cleaned.replace(/<[^>]+>/g, "");

  // Check against injection patterns
  for (const pattern of INJECTION_PATTERNS) {
    if (pattern.test(cleaned)) {
      return "[REMOVED]";
    }
  }

  return cleaned;
}

// ── Error message sanitization ───────────────────────────

export function sanitizeErrorMessage(msg: string): string {
  return msg
    .replace(/api_key=[^&]*/gi, "api_key=[REDACTED]")
    .replace(/apikey=[^&]*/gi, "apikey=[REDACTED]");
}

// ── FRED series definitions ────────────────────────────────

const FRED_SERIES: { id: string; label: string }[] = [
  { id: "DFF",          label: "Fed Funds Rate" },
  { id: "DGS10",        label: "10Y Treasury Yield" },
  { id: "T10Y2Y",       label: "10Y-2Y Yield Spread" },
  { id: "VIXCLS",       label: "VIX" },
  { id: "UNRATE",       label: "Unemployment Rate" },
  { id: "BAMLH0A0HYM2", label: "High Yield Spread" },
  { id: "DTWEXBGS",     label: "USD Trade Weighted Index" },
  { id: "CPIAUCSL",     label: "CPI All Items" },
];

// ── FRED fetch ─────────────────────────────────────────────

async function fetchFredSeries(seriesId: string, apiKey: string): Promise<{ value: number | null; date: string | null; trend: number[] }> {
  const start = new Date();
  start.setDate(start.getDate() - 90);
  const startStr = start.toISOString().slice(0, 10);

  const params = new URLSearchParams({
    series_id:         seriesId,
    api_key:           apiKey,
    file_type:         "json",
    sort_order:        "desc",
    limit:             "5",
    observation_start: startStr,
  });

  const url = `https://api.stlouisfed.org/fred/series/observations?${params}`;
  const res = await fetch(url, { headers: { "Accept": "application/json" }, signal: AbortSignal.timeout(15000) });
  if (!res.ok) throw new Error(`FRED HTTP ${res.status} for ${seriesId}`);

  const data = await res.json() as any;
  const observations: any[] = data?.observations ?? [];
  const valid = observations.filter((o: any) => o.value !== "." && o.value !== undefined);

  if (valid.length === 0) return { value: null, date: null, trend: [] };

  const trend = valid.map((o: any) => parseFloat(o.value)).filter((v: number) => !isNaN(v));
  return {
    value: trend[0] ?? null,
    date:  valid[0]?.date ?? null,
    trend,
  };
}

async function fetchAllFred(apiKey: string): Promise<MacroIndicator[]> {
  const results = await Promise.allSettled(
    FRED_SERIES.map(async (s) => {
      const data = await fetchFredSeries(s.id, apiKey);
      return { id: s.id, label: s.label, ...data } as MacroIndicator;
    })
  );

  const indicators: MacroIndicator[] = [];
  for (const r of results) {
    if (r.status === "fulfilled") indicators.push(r.value);
  }
  return indicators;
}

// ── US Treasury fetch ──────────────────────────────────────

async function fetchTreasuryDebt(): Promise<{ date: string; totalDebt: string; publicDebt: string }[]> {
  const start = new Date();
  start.setDate(start.getDate() - 14);
  const startStr = start.toISOString().slice(0, 10);

  const params = new URLSearchParams({
    fields:       "record_date,tot_pub_debt_out_amt,debt_held_public_amt",
    sort:         "-record_date",
    "page[size]": "5",
    filter:       `record_date:gte:${startStr}`,
  });

  const url = `https://api.fiscaldata.treasury.gov/services/api/fiscal_service/v2/accounting/od/debt_to_penny?${params}`;
  const res = await fetch(url, { headers: { "Accept": "application/json" }, signal: AbortSignal.timeout(15000) });
  if (!res.ok) throw new Error(`Treasury HTTP ${res.status}`);

  const data = await res.json() as any;
  const rows: any[] = data?.data ?? [];
  return rows.map((r: any) => ({
    date:       r.record_date ?? "",
    totalDebt:  r.tot_pub_debt_out_amt ?? "",
    publicDebt: r.debt_held_public_amt ?? "",
  }));
}

// ── GDELT fetch ────────────────────────────────────────────

async function fetchGdeltEvents(): Promise<{ total: number; conflicts: GdeltEvent[]; economy: GdeltEvent[] }> {
  const params = new URLSearchParams({
    query:      "(conflict OR military OR economy OR crisis OR sanctions OR tariff)",
    mode:       "ArtList",
    maxrecords: "25",
    timespan:   "24h",
    format:     "json",
    sort:       "DateDesc",
  });

  const url = `https://api.gdeltproject.org/api/v2/doc/doc?${params}`;
  let res = await fetch(url, { headers: { "Accept": "application/json" }, signal: AbortSignal.timeout(15000) });

  // GDELT rate-limits aggressively — retry twice with backoff on 429
  for (let attempt = 0; attempt < 2 && res.status === 429; attempt++) {
    await new Promise((r) => setTimeout(r, (attempt + 1) * 8000));
    res = await fetch(url, { headers: { "Accept": "application/json" }, signal: AbortSignal.timeout(15000) });
  }
  if (!res.ok) throw new Error(`GDELT HTTP ${res.status}`);

  // GDELT sometimes returns HTML/text even on 200 — guard against bad JSON
  const contentType = res.headers.get("content-type") ?? "";
  const rawText = await res.text();
  if (!contentType.includes("json") && !rawText.startsWith("{") && !rawText.startsWith("[")) {
    throw new Error(`GDELT returned non-JSON: ${rawText.slice(0, 60)}`);
  }

  let data: any;
  try { data = JSON.parse(rawText); } catch { throw new Error(`GDELT JSON parse failed: ${rawText.slice(0, 60)}`); }
  const articles: any[] = data?.articles ?? [];

  const conflicts: GdeltEvent[] = [];
  const economy:   GdeltEvent[] = [];

  const conflictKeywords = ["conflict", "military", "war", "attack", "missile", "troops", "combat", "invasion", "sanction"];
  const economyKeywords  = ["economy", "economic", "tariff", "trade", "gdp", "inflation", "recession", "rate", "bank", "crisis"];

  for (const a of articles) {
    const rawTitle = a.title ?? "";
    const title = rawTitle.toLowerCase();
    const event: GdeltEvent = {
      title:   sanitizeMacroText(rawTitle),
      url:     a.url     ?? "",
      date:    a.seendate ?? "",
      domain:  sanitizeMacroText(a.domain  ?? ""),
      country: sanitizeMacroText(a.sourcecountry ?? ""),
    };

    const isConflict = conflictKeywords.some((k) => title.includes(k));
    const isEconomy  = economyKeywords.some((k)  => title.includes(k));

    if (isConflict) conflicts.push(event);
    else if (isEconomy) economy.push(event);
  }

  return { total: articles.length, conflicts, economy };
}

// ── Alpha Vantage definitions ────────────────────────────

const AV_RSI_SYMBOLS: { symbol: string; name: string }[] = [
  { symbol: "SPY",     name: "S&P 500 ETF" },
  { symbol: "QQQ",     name: "NASDAQ ETF" },
  { symbol: "GLD",     name: "Gold ETF" },
  { symbol: "BTC-USD", name: "Bitcoin" },
];

const AV_ATR_SYMBOLS: { symbol: string; name: string }[] = [
  { symbol: "SPY", name: "S&P 500 ETF" },
  { symbol: "QQQ", name: "NASDAQ ETF" },
];

function isAlphaVantageRateLimited(data: any): boolean {
  return !!(data?.Note || data?.Information);
}

// ── Alpha Vantage fetch ─────────────────────────────────

async function fetchTopGainersLosers(apiKey: string): Promise<{ topGainers: { ticker: string; price: string; changePercent: string }[]; topLosers: { ticker: string; price: string; changePercent: string }[] }> {
  const url = `https://www.alphavantage.co/query?function=TOP_GAINERS_LOSERS&apikey=${apiKey}`;
  const res = await fetch(url, { headers: { "Accept": "application/json" }, signal: AbortSignal.timeout(15000) });
  if (!res.ok) throw new Error(`Alpha Vantage HTTP ${res.status} for TOP_GAINERS_LOSERS`);

  const data = await res.json() as any;
  if (isAlphaVantageRateLimited(data)) throw new Error("Alpha Vantage rate limit hit");

  const rawGainers: any[] = data?.top_gainers ?? [];
  const rawLosers:  any[] = data?.top_losers  ?? [];

  const topGainers = rawGainers.slice(0, 5).map((g: any) => ({
    ticker:        sanitizeMacroText(g.ticker ?? ""),
    price:         g.price ?? "",
    changePercent: g.change_percentage ?? "",
  }));

  const topLosers = rawLosers.slice(0, 5).map((l: any) => ({
    ticker:        sanitizeMacroText(l.ticker ?? ""),
    price:         l.price ?? "",
    changePercent: l.change_percentage ?? "",
  }));

  return { topGainers, topLosers };
}

async function fetchRSI(symbol: string, apiKey: string): Promise<{ value: number; signal: string }> {
  const url = `https://www.alphavantage.co/query?function=RSI&symbol=${symbol}&interval=daily&time_period=14&series_type=close&apikey=${apiKey}`;
  const res = await fetch(url, { headers: { "Accept": "application/json" }, signal: AbortSignal.timeout(15000) });
  if (!res.ok) throw new Error(`Alpha Vantage HTTP ${res.status} for RSI ${symbol}`);

  const data = await res.json() as any;
  if (isAlphaVantageRateLimited(data)) throw new Error("Alpha Vantage rate limit hit");

  const analysis = data?.["Technical Analysis: RSI"] ?? {};
  const dates = Object.keys(analysis).sort().reverse();
  if (dates.length === 0) throw new Error(`No RSI data for ${symbol}`);

  const value = parseFloat(analysis[dates[0]].RSI);
  if (isNaN(value)) throw new Error(`Invalid RSI value for ${symbol}`);

  const signal = value > 70 ? "overbought" : value < 30 ? "oversold" : "neutral";
  return { value, signal };
}

async function fetchATR(symbol: string, apiKey: string): Promise<number> {
  const url = `https://www.alphavantage.co/query?function=ATR&symbol=${symbol}&interval=daily&time_period=14&apikey=${apiKey}`;
  const res = await fetch(url, { headers: { "Accept": "application/json" }, signal: AbortSignal.timeout(15000) });
  if (!res.ok) throw new Error(`Alpha Vantage HTTP ${res.status} for ATR ${symbol}`);

  const data = await res.json() as any;
  if (isAlphaVantageRateLimited(data)) throw new Error("Alpha Vantage rate limit hit");

  const analysis = data?.["Technical Analysis: ATR"] ?? {};
  const dates = Object.keys(analysis).sort().reverse();
  if (dates.length === 0) throw new Error(`No ATR data for ${symbol}`);

  const value = parseFloat(analysis[dates[0]].ATR);
  if (isNaN(value)) throw new Error(`Invalid ATR value for ${symbol}`);

  return value;
}

async function fetchAlphaVantageData(apiKey: string): Promise<AlphaVantageData> {
  const [gainersLosersResult, ...techResults] = await Promise.allSettled([
    fetchTopGainersLosers(apiKey),
    ...AV_RSI_SYMBOLS.map(async (s) => ({ symbol: s.symbol, name: s.name, type: "rsi" as const, result: await fetchRSI(s.symbol, apiKey) })),
    ...AV_ATR_SYMBOLS.map(async (s) => ({ symbol: s.symbol, name: s.name, type: "atr" as const, result: await fetchATR(s.symbol, apiKey) })),
  ]);

  let topGainers: { ticker: string; price: string; changePercent: string }[] = [];
  let topLosers:  { ticker: string; price: string; changePercent: string }[] = [];

  if (gainersLosersResult.status === "fulfilled") {
    topGainers = gainersLosersResult.value.topGainers;
    topLosers  = gainersLosersResult.value.topLosers;
  }

  // Build technicals map: symbol -> AlphaTechnical
  const techMap = new Map<string, AlphaTechnical>();
  for (const s of AV_RSI_SYMBOLS) {
    techMap.set(s.symbol, { symbol: s.symbol, name: s.name });
  }

  for (const r of techResults) {
    if (r.status !== "fulfilled") continue;
    const { symbol, type, result } = r.value as any;
    const tech = techMap.get(symbol);
    if (!tech) continue;

    if (type === "rsi") {
      tech.rsi = result.value;
      tech.rsiSignal = result.signal;
    } else if (type === "atr") {
      tech.atr = result;
    }
  }

  // Only include technicals that have at least one data point
  const technicals = Array.from(techMap.values()).filter((t) => t.rsi !== undefined || t.atr !== undefined);

  return { topGainers, topLosers, technicals };
}

// ── Signal derivation ──────────────────────────────────────

function deriveAlphaVantageSignals(alphaVantage: AlphaVantageData): MacroSignal[] {
  const signals: MacroSignal[] = [];
  for (const tech of alphaVantage.technicals) {
    if (tech.rsi !== undefined && (tech.symbol === "SPY" || tech.symbol === "QQQ")) {
      if (tech.rsi > 70) {
        signals.push({
          source:   "AlphaVantage/RSI",
          signal:   `${tech.symbol} OVERBOUGHT (RSI: ${tech.rsi.toFixed(1)})`,
          severity: "warning",
        });
      } else if (tech.rsi < 30) {
        signals.push({
          source:   "AlphaVantage/RSI",
          signal:   `${tech.symbol} OVERSOLD (RSI: ${tech.rsi.toFixed(1)})`,
          severity: "warning",
        });
      }
    }
  }
  return signals;
}

function deriveSignals(indicators: MacroIndicator[]): MacroSignal[] {
  const signals: MacroSignal[] = [];

  const get = (id: string) => indicators.find((i) => i.id === id);

  const spread    = get("T10Y2Y");
  const vix       = get("VIXCLS");
  const hySpread  = get("BAMLH0A0HYM2");

  if (spread?.value !== null && spread?.value !== undefined) {
    if (spread.value < 0) {
      signals.push({
        source:   "FRED/T10Y2Y",
        signal:   `YIELD CURVE INVERTED — recession signal (spread: ${spread.value.toFixed(2)}%)`,
        severity: "critical",
      });
    }
  }

  if (vix?.value !== null && vix?.value !== undefined) {
    if (vix.value > 40) {
      signals.push({
        source:   "FRED/VIXCLS",
        signal:   `VIX EXTREME — crisis-level fear (VIX: ${vix.value.toFixed(1)})`,
        severity: "critical",
      });
    } else if (vix.value > 30) {
      signals.push({
        source:   "FRED/VIXCLS",
        signal:   `VIX ELEVATED (VIX: ${vix.value.toFixed(1)})`,
        severity: "warning",
      });
    }
  }

  if (hySpread?.value !== null && hySpread?.value !== undefined) {
    if (hySpread.value > 5) {
      signals.push({
        source:   "FRED/BAMLH0A0HYM2",
        signal:   `CREDIT STRESS — high yield spread wide (${hySpread.value.toFixed(2)}%)`,
        severity: "warning",
      });
    }
  }

  return signals;
}

// ── Main snapshot fetch ────────────────────────────────────

export async function fetchMacroSnapshot(): Promise<MacroSnapshot> {
  const errors: string[] = [];
  let indicators: MacroIndicator[] = [];
  let signals:    MacroSignal[]    = [];
  let treasuryDebt: { date: string; totalDebt: string; publicDebt: string }[] = [];
  let geopoliticalEvents = { total: 0, conflicts: [] as GdeltEvent[], economy: [] as GdeltEvent[] };
  let alphaVantage: AlphaVantageData = { topGainers: [], topLosers: [], technicals: [] };

  const fredApiKey = process.env.FRED_API_KEY ?? "";
  const avApiKey   = process.env.ALPHA_VANTAGE_API_KEY ?? "";

  const [fredResult, treasuryResult, gdeltResult, avResult] = await Promise.allSettled([
    fredApiKey
      ? fetchAllFred(fredApiKey)
      : Promise.reject(new Error("FRED_API_KEY not set — skipping FRED")),
    fetchTreasuryDebt(),
    fetchGdeltEvents(),
    avApiKey
      ? fetchAlphaVantageData(avApiKey)
      : Promise.reject(new Error("ALPHA_VANTAGE_API_KEY not set — skipping Alpha Vantage")),
  ]);

  if (fredResult.status === "fulfilled") {
    indicators = fredResult.value;
    signals    = deriveSignals(indicators);
  } else {
    errors.push(sanitizeErrorMessage(`FRED: ${fredResult.reason?.message ?? fredResult.reason}`));
  }

  if (treasuryResult.status === "fulfilled") {
    treasuryDebt = treasuryResult.value;
  } else {
    errors.push(sanitizeErrorMessage(`Treasury: ${treasuryResult.reason?.message ?? treasuryResult.reason}`));
  }

  if (gdeltResult.status === "fulfilled") {
    geopoliticalEvents = gdeltResult.value;
  } else {
    errors.push(sanitizeErrorMessage(`GDELT: ${gdeltResult.reason?.message ?? gdeltResult.reason}`));
  }

  if (avResult.status === "fulfilled") {
    alphaVantage = avResult.value;
    signals = signals.concat(deriveAlphaVantageSignals(alphaVantage));
  } else {
    errors.push(sanitizeErrorMessage(`Alpha Vantage: ${avResult.reason?.message ?? avResult.reason}`));
  }

  return {
    timestamp: new Date(),
    indicators,
    signals,
    treasuryDebt,
    geopoliticalEvents,
    alphaVantage,
    errors,
  };
}

// ── Format for ORACLE prompt ───────────────────────────────

export function formatMacroForPrompt(snapshot: MacroSnapshot): string {
  const lines: string[] = ["=== MACRO & GEOPOLITICAL CONTEXT ===\n"];

  if (snapshot.signals.length > 0) {
    lines.push("--- MACRO SIGNALS ---");
    for (const s of snapshot.signals) {
      const icon = s.severity === "critical" ? "🔴" : s.severity === "warning" ? "🟡" : "ℹ";
      lines.push(`${icon} [${s.severity.toUpperCase()}] ${s.signal}`);
    }
    lines.push("");
  }

  if (snapshot.indicators.length > 0) {
    lines.push("--- FRED INDICATORS ---");
    for (const ind of snapshot.indicators) {
      if (ind.value === null) continue;
      const val   = ind.value.toFixed(2);
      const trend = ind.trend.length >= 2
        ? (ind.trend[0] > ind.trend[1] ? " ↑" : ind.trend[0] < ind.trend[1] ? " ↓" : " →")
        : "";
      lines.push(`${ind.label.padEnd(28)} ${val}%${trend}  (${ind.date ?? "N/A"})`);
    }
    lines.push("");
  }

  if (snapshot.treasuryDebt.length > 0) {
    const latest = snapshot.treasuryDebt[0];
    const total  = latest.totalDebt  ? `$${(parseFloat(latest.totalDebt)  / 1e12).toFixed(2)}T` : "N/A";
    const pub    = latest.publicDebt ? `$${(parseFloat(latest.publicDebt) / 1e12).toFixed(2)}T` : "N/A";
    lines.push("--- US TREASURY DEBT ---");
    lines.push(`Total public debt: ${total}  |  Debt held by public: ${pub}  (${latest.date})`);
    lines.push("");
  }

  if (snapshot.geopoliticalEvents.total > 0) {
    lines.push("--- GEOPOLITICAL EVENTS (last 24h) ---");
    lines.push(`Total articles scanned: ${snapshot.geopoliticalEvents.total}`);
    if (snapshot.geopoliticalEvents.conflicts.length > 0) {
      lines.push("Conflict/Military:");
      for (const e of snapshot.geopoliticalEvents.conflicts.slice(0, 3)) {
        lines.push(`  • ${e.title} (${e.country || e.domain})`);
      }
    }
    if (snapshot.geopoliticalEvents.economy.length > 0) {
      lines.push("Economic/Trade:");
      for (const e of snapshot.geopoliticalEvents.economy.slice(0, 3)) {
        lines.push(`  • ${e.title} (${e.country || e.domain})`);
      }
    }
    lines.push("");
  }

  if (snapshot.alphaVantage.technicals.length > 0 || snapshot.alphaVantage.topGainers.length > 0) {
    lines.push("--- MARKET TECHNICALS (Alpha Vantage) ---");

    const rsiTechs = snapshot.alphaVantage.technicals.filter((t) => t.rsi !== undefined);
    if (rsiTechs.length > 0) {
      lines.push("RSI (14-period daily):");
      for (const t of rsiTechs) {
        const rsiStr    = t.rsi!.toFixed(2);
        const signalStr = t.rsiSignal === "overbought" ? "OVERBOUGHT" : t.rsiSignal === "oversold" ? "OVERSOLD" : "neutral";
        lines.push(`  ${t.name} (${t.symbol})`.padEnd(30) + `${rsiStr.padStart(8)}  ${signalStr}`);
      }
    }

    const atrTechs = snapshot.alphaVantage.technicals.filter((t) => t.atr !== undefined);
    if (atrTechs.length > 0) {
      lines.push("");
      lines.push("ATR (14-period daily):");
      for (const t of atrTechs) {
        lines.push(`  ${t.name} (${t.symbol})`.padEnd(30) + `${t.atr!.toFixed(2).padStart(8)}`);
      }
    }

    if (snapshot.alphaVantage.topGainers.length > 0) {
      lines.push("");
      const gainers = snapshot.alphaVantage.topGainers.map((g) => `${g.ticker} +${g.changePercent.replace("+", "")}`).join(", ");
      lines.push(`Top US Gainers: ${gainers}`);
    }

    if (snapshot.alphaVantage.topLosers.length > 0) {
      const losers = snapshot.alphaVantage.topLosers.map((l) => `${l.ticker} ${l.changePercent}`).join(", ");
      lines.push(`Top US Losers: ${losers}`);
    }

    lines.push("");
  }

  return lines.join("\n");
}

// ── Console summary ────────────────────────────────────────

export function printMacroSummary(snapshot: MacroSnapshot): void {
  if (snapshot.signals.length > 0) {
    console.log(chalk.dim("\n  ── MACRO SIGNALS ──"));
    for (const s of snapshot.signals) {
      const color = s.severity === "critical" ? chalk.red : s.severity === "warning" ? chalk.yellow : chalk.dim;
      console.log(`  ${color(`[${s.severity.toUpperCase()}]`)} ${s.signal}`);
    }
  }

  if (snapshot.indicators.length > 0) {
    console.log(chalk.dim("\n  ── FRED INDICATORS ──"));
    for (const ind of snapshot.indicators) {
      if (ind.value === null) continue;
      const trend = ind.trend.length >= 2
        ? (ind.trend[0] > ind.trend[1] ? chalk.green(" ↑") : ind.trend[0] < ind.trend[1] ? chalk.red(" ↓") : chalk.dim(" →"))
        : "";
      console.log(`  ${chalk.white(ind.label.padEnd(28))} ${chalk.cyan(ind.value.toFixed(2).padStart(8))}${trend}`);
    }
  }

  if (snapshot.treasuryDebt.length > 0) {
    const latest = snapshot.treasuryDebt[0];
    const total  = latest.totalDebt ? `$${(parseFloat(latest.totalDebt) / 1e12).toFixed(2)}T` : "N/A";
    console.log(chalk.dim("\n  ── US TREASURY DEBT ──"));
    console.log(`  ${chalk.white("Total Debt".padEnd(28))} ${chalk.cyan(total.padStart(8))}`);
  }

  if (snapshot.geopoliticalEvents.total > 0) {
    const { conflicts, economy } = snapshot.geopoliticalEvents;
    console.log(chalk.dim("\n  ── GEOPOLITICAL (24h) ──"));
    console.log(`  ${chalk.white("Conflict articles".padEnd(28))} ${chalk.red(String(conflicts.length).padStart(8))}`);
    console.log(`  ${chalk.white("Economic articles".padEnd(28))} ${chalk.yellow(String(economy.length).padStart(8))}`);
  }

  if (snapshot.alphaVantage.technicals.length > 0) {
    console.log(chalk.dim("\n  ── ALPHA VANTAGE TECHNICALS ──"));
    for (const t of snapshot.alphaVantage.technicals) {
      if (t.rsi !== undefined) {
        const rsiColor = t.rsiSignal === "overbought" ? chalk.red : t.rsiSignal === "oversold" ? chalk.green : chalk.cyan;
        const label = `${t.name} (${t.symbol})`;
        console.log(`  ${chalk.white(label.padEnd(28))} RSI ${rsiColor(t.rsi.toFixed(1).padStart(6))} ${rsiColor(t.rsiSignal ?? "")}`);
      }
    }
    for (const t of snapshot.alphaVantage.technicals) {
      if (t.atr !== undefined) {
        const label = `${t.name} (${t.symbol})`;
        console.log(`  ${chalk.white(label.padEnd(28))} ATR ${chalk.cyan(t.atr.toFixed(2).padStart(6))}`);
      }
    }
  }

  console.log("");
}
