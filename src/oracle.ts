// ============================================================
// NEXUS — ORACLE Module
// Analyzes market data using ICT concepts + evolving rules
// ============================================================

import Anthropic from "@anthropic-ai/sdk";
import { getMaxOutputTokens } from "./security";
import * as fs from "fs";
import * as path from "path";
import { formatSnapshotsForPrompt } from "./markets";
import type {
  MarketSnapshot,
  OracleAnalysis,
  AnalysisRules,
} from "./types";

const MEMORY_DIR = path.join(process.cwd(), "memory");
const SYSTEM_PROMPT_PATH  = path.join(MEMORY_DIR, "system-prompt.md");
const ANALYSIS_RULES_PATH = path.join(MEMORY_DIR, "analysis-rules.json");

// ── Load evolving memory ───────────────────────────────────

function loadSystemPrompt(): string {
  if (fs.existsSync(SYSTEM_PROMPT_PATH)) {
    return fs.readFileSync(SYSTEM_PROMPT_PATH, "utf-8");
  }
  return getDefaultSystemPrompt();
}

function loadAnalysisRules(): AnalysisRules {
  if (fs.existsSync(ANALYSIS_RULES_PATH)) {
    return JSON.parse(fs.readFileSync(ANALYSIS_RULES_PATH, "utf-8"));
  }
  return getDefaultRules();
}

// ── Validation ─────────────────────────────────────────────

function validateAnalysisCompleteness(analysis: any): string[] {
  const errors: string[] = [];

  // 1. Check confidence calculation with mathematical breakdown (r014 format)
  if (typeof analysis.confidence !== 'number') {
    errors.push("Missing confidence value");
  } else {
    // Look for mathematical breakdown in analysis text
    const hasBreakdown = /\b(\d+(?:\.\d+)?%?\s*[+\-×÷*/]\s*\d+(?:\.\d+)?%?|\w+:\s*\d+(?:\.\d+)?%?)/i.test(analysis.analysis || "");
    if (!hasBreakdown) {
      errors.push("Confidence calculation missing mathematical breakdown (r014 format required)");
    }
  }

  // 2. Check all setups have required fields
  if (!Array.isArray(analysis.setups)) {
    errors.push("Missing setups array");
  } else {
    analysis.setups.forEach((setup: any, i: number) => {
      const required = ['entry', 'stop', 'target', 'RR', 'timeframe'];
      required.forEach(field => {
        if (!(field in setup) || setup[field] === undefined || setup[field] === null) {
          errors.push(`Setup ${i + 1} missing required field: ${field}`);
        }
      });
    });
  }

  // 3. Check quantitative move classifications (r016 format)
  if (analysis.analysis) {
    const hasQuantitative = /\b(move|swing|impulse|retracement)\s+of\s+\d+(?:\.\d+)?\s*(pips?|points?|%|ticks?)\b/i.test(analysis.analysis);
    if (!hasQuantitative) {
      errors.push("Missing quantitative move classifications per r016 (must specify move sizes in pips/points/%)");
    }
  } else {
    errors.push("Missing analysis text for quantitative classification check");
  }

  return errors;
}

// ── Oracle Analysis ────────────────────────────────────────

export async function runOracleAnalysis(
  client: Anthropic,
  snapshots: MarketSnapshot[],
  sessionId: string,
  sessionNumber: number,
  communityIssues: string = ""
): Promise<OracleAnalysis> {
  const systemPrompt  = loadSystemPrompt();
  const rules         = loadAnalysisRules();
  const marketData    = formatSnapshotsForPrompt(snapshots);
  const rulesText     = formatRulesForPrompt(rules);

  const userMessage = `
${marketData}

${rulesText}

${communityIssues ? communityIssues + "\n\n" : ""}SESSION: #${sessionNumber}
TIMESTAMP: ${new Date().toISOString()}

Analyze the current market conditions. Follow your analysis rules and system instructions exactly.
Respond in the following JSON structure:

{
  "analysis": "Your full narrative market analysis (3-5 paragraphs)",
  "bias": {
    "overall": "bullish|bearish|neutral|mixed",
    "notes": "Brief explanation of overall bias"
  },
  "setups": [
    {
      "instrument": "Name",
      "type": "FVG|OB|Liquidity Sweep|MSS|CISD|PDH/PDL|Other",
      "direction": "bullish|bearish|neutral",
      "description": "What you see",
      "invalidation": "What would invalidate this",
      "entry": 1234.56,
      "stop": 1230.00,
      "target": 1240.00,
      "RR": 1.5,
      "timeframe": "15m|1H|4H|1D"
    }
  ],
  "keyLevels": [
    {
      "instrument": "Name",
      "level": 1234.56,
      "type": "support|resistance|FVG|OB|liquidity",
      "notes": "Why this level matters"
    }
  ],
  "confidence": 65
}

Only respond with the JSON, no other text.`;

  const stripSurrogates = (s: string) => s.replace(/[�-�](?![�-�])|(?<![�-�])[�-�]/g, "");

  const response = await client.messages.create({
    model: "claude-sonnet-4-20250514",
    max_tokens: getMaxOutputTokens(),
    system: stripSurrogates(systemPrompt),
    messages: [{ role: "user", content: stripSurrogates(userMessage) }],
  });

  const rawText = response.content
    .filter((b) => b.type === "text")
    .map((b) => (b as { type: "text"; text: string }).text)
    .join("");

  // Strip markdown fences if present
  const jsonText = rawText.replace(/```json\n?|```\n?/g, "").trim();
  let parsed: any;

  try {
    parsed = JSON.parse(jsonText);
  } catch {
    const salvaged = salvageJSON(jsonText);
    if (salvaged) {
      parsed = salvaged;
      console.warn("  ⚠ ORACLE returned malformed JSON — salvaged partial response");
    } else {
      throw new Error("ORACLE returned unparseable JSON and salvage failed");
    }
  }

  // Validate analysis completeness — warn but don't kill the session
  const validationErrors = validateAnalysisCompleteness(parsed);
  if (validationErrors.length > 0) {
    console.warn(`  ⚠ Analysis validation warnings: ${validationErrors.join('; ')}`);
  }

  return {
    timestamp:       new Date(),
    sessionId,
    marketSnapshots: snapshots,
    analysis:        parsed.analysis,
    setups:          parsed.setups         ?? [],
    bias:            parsed.bias           ?? { overall: "neutral", notes: "" },
    keyLevels:       parsed.keyLevels      ?? [],
    confidence:      parsed.confidence     ?? 50,
  };
}

// ── JSON salvage helper ────────────────────────────────────

function salvageJSON(text: string): any | null {
  let attempt = text;

  const openBraces    = (attempt.match(/{/g)  || []).length;
  const closeBraces   = (attempt.match(/}/g)  || []).length;
  const openBrackets  = (attempt.match(/\[/g) || []).length;
  const closeBrackets = (attempt.match(/]/g)  || []).length;

  // Close any dangling string
  const lastQuote = attempt.lastIndexOf('"');
  const afterLast = attempt.slice(lastQuote + 1);
  if (lastQuote > 0 && !afterLast.includes('"') && (afterLast.includes(',') || afterLast.trim() === '')) {
    attempt = attempt.slice(0, lastQuote + 1);
  }

  attempt = attempt.replace(/,\s*$/, '');

  for (let i = 0; i < openBrackets - closeBrackets; i++) attempt += ']';
  for (let i = 0; i < openBraces   - closeBraces;   i++) attempt += '}';

  try   { return JSON.parse(attempt); }
  catch { return null; }
}

// ── Formatters ─────────────────────────────────────────────

function formatRulesForPrompt(rules: AnalysisRules): string {
  const lines = ["=== YOUR CURRENT ANALYSIS RULES ===\n"];
  lines.push(`Rules version: ${rules.version} | Last updated: ${rules.lastUpdated}`);
  lines.push(`Focus instruments: ${rules.focusInstruments.join(", ")}\n`);

  const byCategory: Record<string, typeof rules.rules> = {};
  for (const r of rules.rules) {
    if (!byCategory[r.category]) byCategory[r.category] = [];
    byCategory[r.category].push(r);
  }

  for (const [cat, items] of Object.entries(byCategory)) {
    lines.push(`[${cat.toUpperCase()}]`);
    for (const r of items.sort((a, b) => b.weight - a.weight)) {
      lines.push(`  [W:${r.weight}] ${r.description}`);
    }
    lines.push("");
  }

  if (rules.sessionNotes) {
    lines.push(`Session notes: ${rules.sessionNotes}`);
  }

  return lines.join("\n");
}

// ── Default initial state ──────────────────────────────────

function getDefaultSystemPrompt(): string {
  return `# NEXUS ORACLE — Market Intelligence System

You are NEXUS, a self-evolving market analysis AI. You analyze global financial markets using ICT (Inner Circle Trader) methodology and price action principles.

## Core Framework
You analyze markets through the lens of:
- **Smart Money Concepts**: Liquidity sweeps, order blocks, fair value gaps (FVGs), displacement
- **Market Structure**: Higher highs/lows, market structure shifts (MSS), changes in state of delivery (CISD)
- **Sessions**: London, New York, Asian session ranges, kill zones
- **Key Levels**: Previous day/week highs and lows (PDH/PDL), weekly opens, monthly levels
- **Intermarket Analysis**: Dollar index (DXY) correlation with forex pairs and risk assets

## Analysis Standards
- Be specific about price levels, not vague about direction
- Identify the highest-probability setup, not just the most obvious one
- Context matters: is this continuation or reversal?
- Always note what would INVALIDATE your analysis
- Risk-off vs risk-on environment affects crypto and indices correlation

## Mindset
You are not here to predict. You are here to identify the most likely path based on current structure and evidence. You are allowed to say "no clear setup" or "conflicting signals." Intellectual honesty beats confident wrongness.

This system prompt will evolve as you learn from each session.`;
}

function getDefaultRules(): AnalysisRules {
  return {
    version:           1,
    lastUpdated:       new Date().toISOString(),
    focusInstruments:  ["NAS100", "EUR/USD", "GBP/JPY", "Gold", "BTC"],
    sessionNotes:      "Initial ruleset — Day 0",
    rules: [
      {
        id:                    "r001",
        category:              "structure",
        description:           "Always identify the higher timeframe (daily) bias before analyzing intraday setups",
        weight:                10,
        addedSession:          0,
        lastModifiedSession:   0,
      },
      {
        id:                    "r002",
        category:              "structure",
        description:           "A market structure shift (MSS) requires a candle close beyond the last swing high/low, not just a wick",
        weight:                9,
        addedSession:          0,
        lastModifiedSession:   0,
      },
      {
        id:                    "r003",
        category:              "fvg",
        description:           "Fair Value Gaps are only valid if formed with displacement (strong impulsive move), not choppy price action",
        weight:                9,
        addedSession:          0,
        lastModifiedSession:   0,
      },
      {
        id:                    "r004",
        category:              "liquidity",
        description:           "Equal highs/lows are liquidity targets — price is drawn to them before reversing",
        weight:                8,
        addedSession:          0,
        lastModifiedSession:   0,
      },
      {
        id:                    "r005",
        category:              "correlation",
        description:           "Check DXY direction when analyzing forex pairs — risk assets (indices, crypto) typically inversely correlate with DXY",
        weight:                8,
        addedSession:          0,
        lastModifiedSession:   0,
      },
      {
        id:                    "r006",
        category:              "sessions",
        description:           "Asian range defines liquidity for London session — London often sweeps Asian highs or lows before the true move",
        weight:                7,
        addedSession:          0,
        lastModifiedSession:   0,
      },
      {
        id:                    "r007",
        category:              "risk",
        description:           "During high-impact news (NFP, CPI, FOMC), flag setups as high-risk and note the event",
        weight:                7,
        addedSession:          0,
        lastModifiedSession:   0,
      },
      {
        id:                    "r008",
        category:              "metals",
        description:           "Gold (XAU) often leads as a risk-off signal — rising gold with falling indices = fear in the market",
        weight:                7,
        addedSession:          0,
        lastModifiedSession:   0,
      },
      {
        id:                    "r009",
        category:              "crypto",
        description:           "Bitcoin dominance matters — if BTC rises while altcoins fall, sentiment is defensive within crypto",
        weight:                6,
        addedSession:          0,
        lastModifiedSession:   0,
      },
      {
        id:                    "r010",
        category:              "discipline",
        description:           "If fewer than 2 confluences align for a setup, classify confidence as low (<40). Never force a trade narrative.",
        weight:                9,
        addedSession:          0,
        lastModifiedSession:   0,
      },
    ],
  };
}
