// ============================================================
// NEXUS — ORACLE Module
// Analyzes market data using ICT concepts + evolving rules
// Two-call architecture: ORACLE-ANALYSIS then ORACLE-SETUPS
// ============================================================

import Anthropic from "@anthropic-ai/sdk";

import * as fs from "fs";
import * as path from "path";
import { formatSnapshotsForPrompt } from "./markets";
import { getMaxOracleOutputTokens } from "./security";
import {
  salvageJSON, stripSurrogates, extractJSONFromResponse, groupBy,
  MEMORY_DIR, SYSTEM_PROMPT_PATH, ANALYSIS_RULES_PATH,
} from "./utils";
import { resolveConfidence, applyCalibrationAdjustment } from "./validate";
import { loadAllJournalEntries } from "./journal";
import { buildCalibrationContext } from "./analytics";
import type {
  MarketSnapshot,
  OracleAnalysis,
  AnalysisRules,
} from "./types";

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
    const hasBreakdown = /\b(\d+(?:\.\d+)?%?\s*[+\-\u00d7\u00f7*/]\s*\d+(?:\.\d+)?%?|\w+:\s*\d+(?:\.\d+)?%?)/i.test(analysis.analysis || "");
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

  // 3. Basic analysis text check
  if (!analysis.analysis) {
    errors.push("Missing analysis text");
  }

  return errors;
}

// ── JSON parsing helper ────────────────────────────────────

function parseOracleJSON(rawText: string, label: string): any {
  const jsonText = extractJSONFromResponse(rawText);

  try {
    return JSON.parse(jsonText);
  } catch {
    let salvaged = salvageJSON(jsonText);

    if (!salvaged) {
      const cutPoints: number[] = [];
      const re = /",\s*"/g;
      let match;
      while ((match = re.exec(jsonText)) !== null) {
        cutPoints.push(match.index + 1);
      }
      for (let i = cutPoints.length - 1; i >= 0; i--) {
        salvaged = salvageJSON(jsonText.slice(0, cutPoints[i]));
        if (salvaged) {
          console.warn(`  \u26a0 ORACLE ${label} response truncated \u2014 salvaged by cutting at field boundary`);
          break;
        }
      }
    }

    if (salvaged) {
      console.warn(`  \u26a0 ORACLE ${label} returned malformed JSON \u2014 salvaged partial response`);
      return salvaged;
    } else {
      return null; // caller decides whether to throw or fallback
    }
  }
}

// ── Oracle Analysis (two-call architecture) ────────────────

export async function runOracleAnalysis(
  client: Anthropic,
  snapshots: MarketSnapshot[],
  sessionId: string,
  sessionNumber: number,
  communityIssues: string = "",
  macroContext: string = "",
  isWeekend: boolean = false
): Promise<OracleAnalysis> {
  const systemPrompt  = loadSystemPrompt();
  const rules         = loadAnalysisRules();

  const marketData    = formatSnapshotsForPrompt(snapshots);
  const rulesText     = formatRulesForPrompt(rules);

  // ── CALL 1: ORACLE-ANALYSIS ──────────────────────────────
  // Focuses purely on market analysis — no setup construction

  // Build explicit instrument checklist for weekend sessions
  const weekendInstrumentList = isWeekend
    ? snapshots.map(s => `- ${s.name} (${s.symbol})`).join("\n")
    : "";

  const weekendContext = isWeekend ? `WEEKEND SESSION — CRYPTO ONLY
Traditional markets (forex, indices, commodities) are closed. Only crypto data is live.
Focus your analysis exclusively on crypto instruments. Do not reference forex, indices,
or commodities as they show Friday's closing prices, not current market conditions.

MANDATORY WEEKEND CHECKLIST — you must address ALL of these instruments in your analysis:
${weekendInstrumentList}
For each instrument: note its price action, trend, and whether it aligns with your bias.
Skipping any instrument on this list is a rule violation (r030).

` : "";

  // Build calibration context from historical data
  const allEntries = loadAllJournalEntries();
  const calibrationContext = buildCalibrationContext(allEntries);

  const analysisUserMessage = `
${weekendContext}${marketData}

${macroContext ? macroContext + "\n\n" : ""}${rulesText}

${communityIssues ? communityIssues + "\n\n" : ""}${calibrationContext ? calibrationContext + "\n\n" : ""}SESSION: #${sessionNumber}
TIMESTAMP: ${new Date().toISOString()}

Analyze the current market conditions. Focus ONLY on market analysis \u2014 do NOT identify trade setups.

FORMAT REQUIREMENTS:

1. NARRATIVE (analysis field): Structure as 4 labeled sections using **Bold:** headers:
   **Higher Timeframe Context:** Daily bias, major index/forex moves with magnitude (pips/points/%)
   **Intraday Analysis:** Session-level price action, DXY direction and correlation impact (per r005). If attributing moves to events, say "assuming" or "if confirmed" (per r011)
   **Cross-Asset Dynamics:** Intermarket correlations, divergences, risk-on/risk-off assessment
   **Technical Confluence Analysis:** Enumerate confluences per r022, then state confidence breakdown
   Each section should be its own paragraph. Do NOT merge them into a single block of text.

2. CONFIDENCE: Calculate using this formula \u2014 do NOT invent your own:
   - Score three components independently (0-100 each):
     technical confluence (TC), macro alignment (MA), risk/reward clarity (RR)
   - Overall = (TC \u00d7 0.4) + (MA \u00d7 0.3) + (RR \u00d7 0.3), rounded to nearest integer
   - Write in your analysis: "Confidence: X% \u2014 TC (Y%), MA (Z%), RR (W%)"
   - Example: TC=70, MA=50, RR=60 \u2192 (70\u00d70.4)+(50\u00d70.3)+(60\u00d70.3) = 28+15+18 = 61%

3. BIAS: "mixed" requires specific justification \u2014 conflicting signals across 3+ asset classes
   or correlation breakdown. Otherwise pick a direction (per r015).

4. KEY LEVELS: Identify important support/resistance levels across all instruments.

5. ASSUMPTIONS (r011 \u2014 MANDATORY): List every causal attribution to an unverified external event
   in the "assumptions" array. This includes geopolitical events, central bank actions, earnings,
   or any "X caused Y" claim not confirmed by price data alone.
   - BAD: weaving "Iran war escalation driving oil surge" into the narrative without documenting it
   - GOOD: list it in assumptions[], then write in the narrative: "oil surge consistent with supply
     shock premium (see assumptions)"
   - Use [] ONLY when every move is attributed purely to technical structure with zero reference to
     external events. When in doubt, list it.

Respond in JSON:

{
  "analysis": "Full narrative with quantified moves, HTF-first structure, and confidence breakdown",
  "bias": {
    "overall": "bullish|bearish|neutral|mixed",
    "notes": "Brief explanation \u2014 if mixed, state which signals conflict"
  },
  "assumptions": [
    "Each unverified causal attribution as a separate string \u2014 e.g. 'Iran escalation driving oil surge \u2014 unconfirmed from price data alone'"
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

The "confidence" field MUST match the confidence calculated in your analysis text.
Do not calculate 73% in your narrative and return 50% in the JSON.

Only respond with the JSON, no other text.`;

  console.log("  ORACLE analyzing market structure...");

  const analysisResponse = await client.messages.create({
    model: "claude-sonnet-4-20250514",
    max_tokens: getMaxOracleOutputTokens(),
    system: stripSurrogates(systemPrompt),
    messages: [{ role: "user", content: stripSurrogates(analysisUserMessage) }],
  });

  const analysisWasTruncated = analysisResponse.stop_reason === "max_tokens";
  if (analysisWasTruncated) {
    console.warn("  \u26a0 ORACLE analysis response was truncated (hit max_tokens) \u2014 will attempt salvage");
  }

  const analysisRawText = analysisResponse.content
    .filter((b) => b.type === "text")
    .map((b) => (b as { type: "text"; text: string }).text)
    .join("");

  const parsed = parseOracleJSON(analysisRawText, "analysis");
  if (!parsed) {
    console.error(`  \u2717 ORACLE analysis raw response (first 500 chars): ${analysisRawText.slice(0, 500)}`);
    throw new Error("ORACLE returned unparseable JSON and salvage failed");
  }

  // ── CALL 2: ORACLE-SETUPS ──────────────────────────────────
  // Takes analysis results and constructs precise trade setups

  const biasOverall = parsed.bias?.overall ?? "neutral";
  const biasNotes   = parsed.bias?.notes ?? "";
  const keyLevelsFormatted = (parsed.keyLevels ?? [])
    .map((kl: any) => `${kl.instrument}: ${kl.level} (${kl.type}) \u2014 ${kl.notes}`)
    .join("\n");

  // Build the pre-filled JSON template — every instrument slot must be filled by ORACLE
  const weekendTemplate = isWeekend ? buildWeekendInstrumentTemplate(snapshots) : "";

  const weekendSetupNote = isWeekend ? `\nThis is a WEEKEND session — only construct setups for crypto instruments.
You MUST fill in EVERY slot in the JSON template below. Do NOT add or remove slots.
For each instrument:
  - If a valid structural level exists aligned with your bias → fill in entry, stop, target, RR, timeframe, set direction to "bullish" or "bearish"
  - If no valid setup exists → leave entry/stop/target/RR/timeframe as null, set direction to "neutral", explain briefly in description
All ${snapshots.length} instruments must be accounted for. Returning fewer slots is a rule violation.

START WITH THIS TEMPLATE (fill in every slot):
${weekendTemplate}
\n` : "";

  const r029Note = buildR029StopNote(snapshots);
  const minSetupNote = buildMinSetupNote(parsed.confidence ?? 50);

  const rawConf = parsed.confidence ?? 50;
  const weekdayTemplate = !isWeekend ? buildWeekdayScreeningTemplate(snapshots, rawConf) : "";
  const weekdayScreeningNote = weekdayTemplate
    ? `\nSYSTEMATIC SCREENING REQUIRED (your confidence is ${rawConf}%):
You MUST fill in EVERY slot in the JSON template below. Do NOT add or remove slots.
For each instrument:
  - If a valid structural level exists aligned with your bias → fill in entry, stop, target, RR, timeframe, set direction to "bullish" or "bearish"
  - If no valid setup exists → leave entry/stop/target/RR/timeframe as null, set direction to "neutral", explain briefly in description
All ${snapshots.length} instruments must be accounted for. Returning fewer slots is a rule violation (r034).

START WITH THIS TEMPLATE (fill in every slot):
${weekdayTemplate}
\n`
    : "";

  const setupsUserMessage = `You are NEXUS ORACLE's setup construction engine. You have just completed market analysis.
${weekendSetupNote}${weekdayScreeningNote}

YOUR ANALYSIS:
${parsed.analysis ?? ""}

YOUR BIAS: ${biasOverall} \u2014 ${biasNotes}
YOUR CONFIDENCE: ${parsed.confidence ?? 50}%

KEY LEVELS IDENTIFIED:
${keyLevelsFormatted || "None identified"}

CURRENT PRICES:
${marketData}

YOUR TASK: Construct trade setups aligned with your ${biasOverall} bias.

RULES:
- You MUST systematically evaluate EVERY instrument in the price data for potential setups
- For each instrument, either include a setup OR briefly note why none exists (no structural level nearby, no alignment with theme)
- When a clear macro theme is present (USD strength, risk-off, forced liquidation, correlation breakdown), you MUST screen all asset classes: forex majors, indices, crypto, metals, energy
- Minimum setups: at least 3 when confidence > 50%, at least 4 when confidence > 60%${minSetupNote}
- Weekend crypto sessions: at least 2 setups from available crypto instruments regardless of confidence
- Every setup MUST have: entry, stop, target, RR, timeframe
- ENTRY: nearest support/resistance, session high/low, or key level
- STOP: beyond the next structural level, or 1x ATR from entry${r029Note}
- TARGET: next liquidity level, psychological number, or swing point
- RR must be > 1.3 \u2014 do not include setups with risk exceeding reward
- Include instrument, type, direction, description, and invalidation
- TYPE must be a specific ICT pattern: FVG, OB, Liquidity Sweep, MSS, CISD, or PDH/PDL. These apply to ALL markets including crypto. "Other" is only acceptable if the setup genuinely does not fit any ICT pattern — do not use "Other" as a default.

Respond with ONLY a JSON array:
[
  {
    "instrument": "Name",
    "type": "FVG|OB|Liquidity Sweep|MSS|CISD|PDH/PDL|Other",
    "direction": "bullish|bearish|neutral",
    "description": "What you see and why",
    "invalidation": "What would invalidate this",
    "entry": 1234.56,
    "stop": 1230.00,
    "target": 1240.00,
    "RR": 1.5,
    "timeframe": "15m|1H|4H|1D"
  }
]

Only respond with the JSON array, no other text.`;

  console.log("  ORACLE constructing setups...");

  let rawSetups: any[] = [];
  try {
    const setupsResponse = await client.messages.create({
      model: "claude-sonnet-4-20250514",
      max_tokens: getMaxOracleOutputTokens(),
      system: stripSurrogates(systemPrompt),
      messages: [{ role: "user", content: stripSurrogates(setupsUserMessage) }],
    });

    const setupsWasTruncated = setupsResponse.stop_reason === "max_tokens";
    if (setupsWasTruncated) {
      console.warn("  \u26a0 ORACLE setups response was truncated (hit max_tokens) \u2014 will attempt salvage");
    }

    const setupsRawText = setupsResponse.content
      .filter((b) => b.type === "text")
      .map((b) => (b as { type: "text"; text: string }).text)
      .join("");

    const setupsParsed = parseOracleJSON(setupsRawText, "setups");
    if (!setupsParsed) {
      console.warn("  \u26a0 ORACLE setup construction failed \u2014 continuing with analysis only");
      rawSetups = [];
    } else if (Array.isArray(setupsParsed)) {
      rawSetups = setupsParsed;
    } else if (setupsParsed && Array.isArray(setupsParsed.setups)) {
      rawSetups = setupsParsed.setups;
    } else {
      rawSetups = [];
    }
  } catch (err) {
    console.warn(`  \u26a0 ORACLE setup construction failed \u2014 continuing with analysis only: ${err}`);
    rawSetups = [];
  }

  // ── Merge & validate both calls ────────────────────────────

  // For weekend sessions: separate neutral "screened" entries from real setups,
  // then merge screening key levels into the analysis key levels so
  // validateWeekendCryptoScreening counts them as covered (r030 compliance).
  let screeningKeyLevels: any[] = [];
  if (isWeekend) {
    const { validSetups: weekendValid, screeningKeyLevels: weekendScreened } =
      parseWeekendSetups(rawSetups, snapshots);
    rawSetups = weekendValid;
    screeningKeyLevels = weekendScreened;

    // Patch: auto-inject neutral screened entry for any snapshot ORACLE dropped
    const coveredNames = new Set([
      ...weekendValid.map((s: any) => (s.instrument ?? "").toLowerCase()),
      ...weekendScreened.map((kl: any) => (kl.instrument ?? "").toLowerCase()),
    ]);
    const droppedSnaps = snapshots.filter(s =>
      !coveredNames.has(s.name.toLowerCase()) &&
      !coveredNames.has(s.symbol.toLowerCase().replace(/-usd[t]?$/, ""))
    );
    if (droppedSnaps.length > 0) {
      for (const snap of droppedSnaps) {
        screeningKeyLevels.push({
          instrument: snap.name,
          level: snap.price,
          type: "support",
          notes: `Auto-injected: ORACLE omitted ${snap.name} from weekend screening response (r030 compliance patch)`,
        });
        console.warn(`  ⚠ Weekend screening: ORACLE omitted ${snap.name} — auto-injected neutral screened entry`);
      }
    }

    if (weekendScreened.length > 0 || droppedSnaps.length > 0) {
      console.log(`  📋 Weekend screening: ${weekendValid.length} setups + ${screeningKeyLevels.length} screened (no-setup) instrument(s) added to key levels`);
    }
  }

  // Validate analysis completeness
  parsed.setups = rawSetups;
  const validationErrors = validateAnalysisCompleteness(parsed);
  if (validationErrors.length > 0) {
    console.warn(`  \u26a0 Analysis validation warnings: ${validationErrors.join('; ')}`);
  }

  // Filter out setups with missing fields, bad geometry, or insufficient R:R
  const validSetups = rawSetups.filter((s: any) => {
    const hasEntry  = typeof s.entry  === "number" && s.entry  !== 0;
    const hasStop   = typeof s.stop   === "number" && s.stop   !== 0;
    const hasTarget = typeof s.target === "number" && s.target !== 0;
    const hasTF     = typeof s.timeframe === "string" && s.timeframe.length > 0;
    if (!hasEntry || !hasStop || !hasTarget || !hasTF) {
      console.warn(`  \u26a0 Dropped setup: ${s.instrument ?? "unknown"} — missing required field (entry=${s.entry}, stop=${s.stop}, target=${s.target}, TF=${s.timeframe})`);
      return false;
    }

    // Geometry check: stop and target must be on the correct side of entry
    const dir = (s.direction ?? "").toLowerCase();
    if (dir === "bullish") {
      if (s.stop >= s.entry) {
        console.warn(`  \u26a0 Dropped setup: ${s.instrument} — bullish but stop (${s.stop}) >= entry (${s.entry})`);
        return false;
      }
      if (s.target <= s.entry) {
        console.warn(`  \u26a0 Dropped setup: ${s.instrument} — bullish but target (${s.target}) <= entry (${s.entry})`);
        return false;
      }
    } else if (dir === "bearish") {
      if (s.stop <= s.entry) {
        console.warn(`  \u26a0 Dropped setup: ${s.instrument} — bearish but stop (${s.stop}) <= entry (${s.entry})`);
        return false;
      }
      if (s.target >= s.entry) {
        console.warn(`  \u26a0 Dropped setup: ${s.instrument} — bearish but target (${s.target}) >= entry (${s.entry})`);
        return false;
      }
    }

    // Cross-check R:R against actual math — don't trust the model's self-reported value
    let calculatedRR: number;
    if (dir === "bullish") {
      calculatedRR = (s.target - s.entry) / (s.entry - s.stop);
    } else if (dir === "bearish") {
      calculatedRR = (s.entry - s.target) / (s.stop - s.entry);
    } else {
      // Unknown direction — fall back to self-reported RR
      calculatedRR = typeof s.RR === "number" ? s.RR : 0;
    }

    if (calculatedRR < 1.3) {
      console.warn(`  \u26a0 Dropped setup: ${s.instrument} — calculated R:R ${calculatedRR.toFixed(2)} < 1.3 (self-reported: ${s.RR})`);
      return false;
    }

    // Overwrite self-reported RR with the verified calculated value
    s.RR = parseFloat(calculatedRR.toFixed(2));
    return true;
  });

  if (validSetups.length < rawSetups.length) {
    console.warn(`  \u26a0 ${rawSetups.length - validSetups.length} setup(s) dropped — see warnings above`);
  }

  // Fix undefined bias notes
  if (parsed.bias) {
    if (!parsed.bias.notes || parsed.bias.notes === "undefined" || parsed.bias.notes.trim() === "") {
      parsed.bias.notes = `${(parsed.bias.overall ?? "neutral").toUpperCase()} bias identified`;
    }
  }

  // Resolve text vs JSON confidence mismatch
  let finalConfidence = resolveConfidence(parsed.analysis ?? "", parsed.confidence ?? 50);

  // Apply programmatic calibration based on historical hit rate data
  const preCalibration = finalConfidence;
  finalConfidence = applyCalibrationAdjustment(finalConfidence, biasOverall);
  if (finalConfidence !== preCalibration) {
    console.log(`  📊 Calibration adjustment: ${preCalibration}% → ${finalConfidence}% (bias: ${biasOverall})`);
  }

  // Enforce: high confidence with zero setups is contradictory
  if (finalConfidence > 60 && validSetups.length === 0) {
    console.warn(`  \u26a0 ORACLE contradiction: ${finalConfidence}% confidence but 0 setups \u2014 forcing confidence to 35%`);
    finalConfidence = 35;
  }

  // Enforce minimum setup counts based on confidence
  const minSetups = isWeekend
    ? 2
    : finalConfidence > 60 ? 4 : finalConfidence > 50 ? 3 : 0;

  if (minSetups > 0 && validSetups.length < minSetups) {
    console.warn(`  \u26a0 ORACLE screening gap: ${validSetups.length} setups but minimum ${minSetups} required at ${finalConfidence}% confidence \u2014 reducing confidence to ${Math.min(finalConfidence, 45)}%`);
    finalConfidence = Math.min(finalConfidence, 45);
  }

  return {
    timestamp:       new Date(),
    sessionId,
    marketSnapshots: snapshots,
    analysis:        parsed.analysis,
    setups:          validSetups,
    bias:            parsed.bias           ?? { overall: "neutral", notes: "" },
    keyLevels:       [...(parsed.keyLevels ?? []), ...screeningKeyLevels],
    confidence:      finalConfidence,
    assumptions:     Array.isArray(parsed.assumptions) ? parsed.assumptions : [],
  };
}

// ── Weekend structural enforcement ───────────────────────

/**
 * Builds a JSON template string with one pre-filled slot per instrument.
 * Injected into the ORACLE SETUPS prompt so ORACLE must fill in every slot —
 * it cannot omit instruments by simply not mentioning them.
 */
export function buildWeekendInstrumentTemplate(snapshots: MarketSnapshot[]): string {
  const slots = snapshots.map(s => ({
    instrument:  s.name,
    type:        "Other",
    direction:   "neutral",
    description: "",
    invalidation: "",
    entry:       null,
    stop:        null,
    target:      null,
    RR:          null,
    timeframe:   null,
  }));
  return JSON.stringify(slots, null, 2);
}

/**
 * Separates raw weekend ORACLE setups into valid tradeable setups and
 * screening key levels (neutral/no-setup entries).
 *
 * Neutral entries count as "covered" for r030 screening without being
 * included as trades. Their current price becomes the key level.
 */
export function parseWeekendSetups(
  rawSetups: any[],
  snapshots: MarketSnapshot[]
): { validSetups: any[]; screeningKeyLevels: any[] } {
  const priceMap: Record<string, number> = {};
  for (const s of snapshots) {
    priceMap[s.name.toLowerCase()] = s.price;
    priceMap[s.symbol.toLowerCase().replace(/-usd[t]?$/, "")] = s.price;
  }

  const validSetups: any[] = [];
  const screeningKeyLevels: any[] = [];

  for (const s of rawSetups) {
    const isNeutral = s.direction === "neutral" || s.entry == null;
    if (isNeutral) {
      const name = (s.instrument ?? "").toLowerCase();
      const price = priceMap[name] ?? priceMap[name.replace(/[^a-z]/g, "")] ?? 0;
      screeningKeyLevels.push({
        instrument: s.instrument,
        level:      price,
        type:       "screened",
        notes:      s.description || "Screened — no setup identified",
      });
    } else {
      validSetups.push(s);
    }
  }

  return { validSetups, screeningKeyLevels };
}

// ── Risk/Reward Warning ───────────────────────────────────

export function warnPoorRiskReward(setups: any[]): void {
  for (const s of setups) {
    if (typeof s.RR === "number" && s.RR < 1.3) {
      console.warn(`  ⚠ Setup ${s.instrument ?? "unknown"} has poor risk/reward (RR=${s.RR.toFixed(2)}) — minimum 1.3 required`);
    }
  }
}

// ── r029 stop distance enforcement ────────────────────────
// Returns a prompt block telling ORACLE the minimum stop distance required
// for this session based on live market volatility. Empty string = no constraint.
export function buildR029StopNote(snapshots: MarketSnapshot[]): string {
  if (!snapshots.length) return "";
  const maxMove = Math.max(...snapshots.map(s => Math.abs(s.changePercent ?? 0)));
  if (maxMove >= 5) {
    return `\nMANDATORY STOP REQUIREMENT (r029 — extreme volatility detected: max session move ${maxMove.toFixed(1)}%):
Every stop MUST be at least 1.5% from entry. Verify before finalising: |entry - stop| / entry ≥ 0.015.
Do NOT include any setup where the stop is closer than 1.5% from entry.\n`;
  }
  if (maxMove >= 3) {
    return `\nMANDATORY STOP REQUIREMENT (r029 — moderate volatility detected: max session move ${maxMove.toFixed(1)}%):
Every stop MUST be at least 1.0% from entry. Verify before finalising: |entry - stop| / entry ≥ 0.010.
Do NOT include any setup where the stop is closer than 1.0% from entry.\n`;
  }
  return "";
}

// ── Weekday instrument screening template ─────────────────
// When confidence >= 50 on weekday sessions, returns a pre-filled JSON template
// (same pattern as the weekend template) forcing ORACLE to evaluate every
// instrument instead of cherry-picking the most dramatic one.
// Empty string when confidence < 50 or no snapshots.
export function buildWeekdayScreeningTemplate(snapshots: MarketSnapshot[], confidence: number): string {
  if (confidence < 50 || !snapshots.length) return "";
  const slots = snapshots.map(s => ({
    instrument:   s.name,
    type:         "Other",
    direction:    "neutral",
    description:  "",
    invalidation: "",
    entry:        null,
    stop:         null,
    target:       null,
    RR:           null,
    timeframe:    null,
  }));
  return JSON.stringify(slots, null, 2);
}

// ── Minimum setup count enforcement ───────────────────────
// Returns a prompt block telling ORACLE how many setups are MANDATORY
// based on its reported confidence. Empty string when confidence < 50.
export function buildMinSetupNote(confidence: number): string {
  if (confidence < 50) return "";
  const minSetups = confidence >= 60 ? 4 : 3;
  return `\nMANDATORY SETUP COUNT (your confidence is ${confidence}%): You MUST provide at least ${minSetups} setups. Returning fewer is a rule violation (r034). Systematically screen ALL instruments — forex majors, indices, crypto, commodities — before concluding no setup exists.\n`;
}

// ── Formatters ─────────────────────────────────────────────

function formatRulesForPrompt(rules: AnalysisRules): string {
  const lines = ["=== YOUR CURRENT ANALYSIS RULES ===\n"];
  lines.push(`Rules version: ${rules.version} | Last updated: ${rules.lastUpdated}`);
  lines.push(`Focus instruments: ${rules.focusInstruments.join(", ")}\n`);

  const activeRules = rules.rules.filter((r: any) => !r.disabled);
  const byCategory = groupBy(activeRules, (r) => r.category);

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
  return `# NEXUS ORACLE \u2014 Market Intelligence System

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
    sessionNotes:      "Initial ruleset \u2014 Day 0",
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
        description:           "Equal highs/lows are liquidity targets \u2014 price is drawn to them before reversing",
        weight:                8,
        addedSession:          0,
        lastModifiedSession:   0,
      },
      {
        id:                    "r005",
        category:              "correlation",
        description:           "Check DXY direction when analyzing forex pairs \u2014 risk assets (indices, crypto) typically inversely correlate with DXY",
        weight:                8,
        addedSession:          0,
        lastModifiedSession:   0,
      },
      {
        id:                    "r006",
        category:              "sessions",
        description:           "Asian range defines liquidity for London session \u2014 London often sweeps Asian highs or lows before the true move",
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
        category:              "commodities",
        description:           "Gold (XAU) often leads as a risk-off signal \u2014 rising gold with falling indices = fear in the market",
        weight:                7,
        addedSession:          0,
        lastModifiedSession:   0,
      },
      {
        id:                    "r009",
        category:              "crypto",
        description:           "Bitcoin dominance matters \u2014 if BTC rises while altcoins fall, sentiment is defensive within crypto",
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
