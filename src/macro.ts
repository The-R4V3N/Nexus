// ============================================================
// NEXUS — Macro & Geopolitical Data Module
// Fetches FRED indicators, US Treasury debt, and GDELT events
// ============================================================

import chalk from "chalk";
import type { MacroSnapshot, MacroIndicator, MacroSignal, GdeltEvent } from "./types";

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
  const res = await fetch(url, { headers: { "Accept": "application/json" } });
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
  const res = await fetch(url, { headers: { "Accept": "application/json" } });
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
  let res = await fetch(url, { headers: { "Accept": "application/json" } });

  // GDELT rate-limits aggressively — retry twice with backoff on 429
  for (let attempt = 0; attempt < 2 && res.status === 429; attempt++) {
    await new Promise((r) => setTimeout(r, (attempt + 1) * 8000));
    res = await fetch(url, { headers: { "Accept": "application/json" } });
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
    const title = (a.title ?? "").toLowerCase();
    const event: GdeltEvent = {
      title:   a.title   ?? "",
      url:     a.url     ?? "",
      date:    a.seendate ?? "",
      domain:  a.domain  ?? "",
      country: a.sourcecountry ?? "",
    };

    const isConflict = conflictKeywords.some((k) => title.includes(k));
    const isEconomy  = economyKeywords.some((k)  => title.includes(k));

    if (isConflict) conflicts.push(event);
    else if (isEconomy) economy.push(event);
  }

  return { total: articles.length, conflicts, economy };
}

// ── Signal derivation ──────────────────────────────────────

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

  const fredApiKey = process.env.FRED_API_KEY ?? "";

  const [fredResult, treasuryResult, gdeltResult] = await Promise.allSettled([
    fredApiKey
      ? fetchAllFred(fredApiKey)
      : Promise.reject(new Error("FRED_API_KEY not set — skipping FRED")),
    fetchTreasuryDebt(),
    fetchGdeltEvents(),
  ]);

  if (fredResult.status === "fulfilled") {
    indicators = fredResult.value;
    signals    = deriveSignals(indicators);
  } else {
    errors.push(`FRED: ${fredResult.reason?.message ?? fredResult.reason}`);
  }

  if (treasuryResult.status === "fulfilled") {
    treasuryDebt = treasuryResult.value;
  } else {
    errors.push(`Treasury: ${treasuryResult.reason?.message ?? treasuryResult.reason}`);
  }

  if (gdeltResult.status === "fulfilled") {
    geopoliticalEvents = gdeltResult.value;
  } else {
    errors.push(`GDELT: ${gdeltResult.reason?.message ?? gdeltResult.reason}`);
  }

  return {
    timestamp: new Date(),
    indicators,
    signals,
    treasuryDebt,
    geopoliticalEvents,
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

  console.log("");
}
