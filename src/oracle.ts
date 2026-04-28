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
import { resolveConfidence, applySetupCountPenalty } from "./validate";
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

  const r041Note = !isWeekend ? buildR041ScreeningNote() : "";
  const r044Note = isWeekend  ? buildR044DepthNote(snapshots, isWeekend) : "";

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
${r041Note}${r044Note}
${buildR011AssumptionNote()}

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
  const rrSelfCheckNote = buildRRSelfCheckNote();
    // Pre-reconcile confidence before building ORACLE-SETUPS prompt.
  // ORACLE-ANALYSIS may return a low JSON confidence (e.g. 45) while its analysis
  // text clearly states a higher value (e.g. 58%). Using the raw JSON field here
  // meant buildWeekdayScreeningTemplate and buildMinSetupNote received sub-50
  // confidence and injected NO enforcement into ORACLE-SETUPS — root cause of the
  // persistent 0-setup sessions (#174-#176, #178). resolveConfidence honours the
  // text value when JSON diverges >10pts or when cap notation is present.
  const rawConf = resolveConfidence(parsed.analysis ?? "", parsed.confidence ?? 50);
  // r031 cap notation: inject when ORACLE calculated >65% without self-documenting the cap
  parsed.analysis = enforceR031CapNotation(parsed.analysis ?? "", rawConf);
  const executionForceNote = !isWeekend ? buildExecutionForceNote(parsed.analysis ?? "", rawConf) : "";
  const crossAssetNote = !isWeekend ? buildR039R040CrossAssetNote(snapshots, rawConf) : "";
  const oilEnforcementNote = !isWeekend ? buildOilEnforcementNote(snapshots, rawConf) : "";
  const largeMoverNote = buildLargeMoverCoverageNote(snapshots, rawConf);
  const minSetupNote = buildMinSetupNote(rawConf);
  const weekdayTemplate = !isWeekend ? buildWeekdayScreeningTemplate(snapshots, rawConf) : "";
  const minNonNeutral = rawConf >= 60 ? 4 : 3;
  const weekdayScreeningNote = weekdayTemplate
    ? `\nSYSTEMATIC SCREENING REQUIRED (your confidence is ${rawConf}%):
You MUST fill in EVERY slot in the JSON template below. Do NOT add or remove slots.
For each instrument:
  - If a valid structural level exists aligned with your bias → fill in entry, stop, target, RR, timeframe, set direction to "bullish" or "bearish"
  - If no valid setup exists → leave entry/stop/target/RR/timeframe as null, set direction to "neutral", explain briefly in description
All ${snapshots.length} instruments must be accounted for. Returning fewer slots is a rule violation (r034).

CRITICAL: Neutral entries (direction: "neutral") do NOT count as setups. At confidence ${rawConf}%, you MUST have at least ${minNonNeutral} slots with direction "bullish" or "bearish" and all numeric fields populated. Setting every slot to "neutral" is a direct violation of r034. Your ${biasOverall} bias with documented confluences guarantees structural opportunities exist — commit to them.

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
- STOP: beyond the next structural level, or 1x ATR from entry${r029Note}${crossAssetNote}${oilEnforcementNote}${largeMoverNote}
- TARGET: next liquidity level, psychological number, or swing point
- RR must be > 1.3 \u2014 do not include setups with risk exceeding reward${rrSelfCheckNote}${executionForceNote}
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

  // Reclassify "Other" setup types to the correct ICT pattern based on description keywords.
  // Code enforcement backup for ORACLE's tendency to use "Other" as a default catch-all.
  const reclassifiedSetups = reclassifyOtherSetups(validSetups);

  // Fix undefined bias notes
  if (parsed.bias) {
    if (!parsed.bias.notes || parsed.bias.notes === "undefined" || parsed.bias.notes.trim() === "") {
      parsed.bias.notes = `${(parsed.bias.overall ?? "neutral").toUpperCase()} bias identified`;
    }
  }

  // Compute final confidence: text/JSON reconciliation → r031 auto-cap → zero-setup floor → setup-count penalty.
  // Uses computeOracleConfidence so the pipeline is testable and agent.ts does not need to
  // call resolveConfidence again (which would undo any penalty — backlog #23 double-call bug).
  let finalConfidence = computeOracleConfidence(
    parsed.analysis ?? "",
    parsed.confidence ?? 50,
    validSetups.length,
    isWeekend
  );

  // r039/r040 code enforcement: penalize confidence when setups cover only 1 asset class
  // despite multi-class market conditions. Backup to buildR039R040CrossAssetNote prompt injection.
  const { penalized: confAfterCrossAsset, reason: crossAssetReason } = applyR039R040Penalty(
    finalConfidence, snapshots, reclassifiedSetups, isWeekend
  );
  if (crossAssetReason) {
    console.warn(`  ⚠ ORACLE ${crossAssetReason}`);
    finalConfidence = confAfterCrossAsset;
  }

  // r041 code enforcement: auto-inject screening validation line when ORACLE omitted it
  // despite confidence > 55%. Backup to buildR041ScreeningNote prompt injection.
  const finalAnalysis = enforceR041ScreeningValidation(parsed.analysis ?? "", snapshots, finalConfidence);

  return {
    timestamp:       new Date(),
    sessionId,
    marketSnapshots: snapshots,
    analysis:        finalAnalysis,
    setups:          reclassifiedSetups,
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
  const extremeInstruments = snapshots.filter(s => Math.abs(s.changePercent ?? 0) >= 5);
  const moderateInstruments = snapshots.filter(s => {
    const move = Math.abs(s.changePercent ?? 0);
    return move >= 3 && move < 5;
  });
  if (!extremeInstruments.length && !moderateInstruments.length) return "";

  const lines: string[] = ["\nMANDATORY STOP REQUIREMENT (r029 — per-instrument volatility):"];
  for (const s of extremeInstruments) {
    lines.push(`  • ${s.name} (moved ${Math.abs(s.changePercent ?? 0).toFixed(1)}%): stop MUST be ≥1.5% from entry`);
  }
  for (const s of moderateInstruments) {
    lines.push(`  • ${s.name} (moved ${Math.abs(s.changePercent ?? 0).toFixed(1)}%): stop MUST be ≥1.0% from entry`);
  }
  lines.push("Instruments NOT listed above have NO minimum stop requirement from r029.");
  lines.push("Verify: |entry - stop| / entry meets the threshold for each listed instrument.\n");
  return lines.join("\n");
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
  return `\nMANDATORY SETUP COUNT (your confidence is ${confidence}%): You MUST provide at least ${minSetups} setups with direction "bullish" or "bearish" and all fields populated. Neutral entries (direction: "neutral") do NOT count as setups — they are screened rejections only. Returning fewer than ${minSetups} non-neutral setups is a rule violation (r034). Systematically screen ALL instruments — forex majors, indices, crypto, commodities — before concluding no setup exists.\n`;
}

// ── Confidence computation (three-step pipeline) ──────────
// Encapsulates the three confidence transformations applied after ORACLE-ANALYSIS:
//   1. resolveConfidence  — reconcile analysis text vs JSON field (text wins when diff >10pts or cap explicit)
//   2. Zero-setup floor   — >60% confidence with 0 setups is contradictory → force to 35%
//   3. applySetupCountPenalty — proportional penalty when setups < minimum for this confidence level
//
// Exported so agent.ts can call this once and avoid a second resolveConfidence call that
// would silently undo any penalty applied in step 3 (backlog #23 double-call bug).
export function computeOracleConfidence(
  analysisText: string,
  jsonConfidence: number,
  setupCount: number,
  isWeekend: boolean
): number {
  let c = resolveConfidence(analysisText, jsonConfidence);

  // r031 code enforcement: confidence cannot exceed 65 without explicit cap notation.
  // ORACLE is prompted to include "capped at X%" when it computes >65%, but when it
  // ignores that requirement the code enforces the cap regardless.
  if (c > 65 && !analysisText.match(/capped\s+(?:at|to)\s*\d+%/i)) {
    console.warn(`  ⚠ ORACLE r031: ${c}% confidence exceeds 65 cap without notation — auto-capping to 65%`);
    c = 65;
  }

  if (c > 60 && setupCount === 0) {
    console.warn(`  ⚠ ORACLE contradiction: ${c}% confidence but 0 setups — forcing to 35%`);
    c = 35;
  }
  const { penalized, reason } = applySetupCountPenalty(c, setupCount, isWeekend);
  if (reason) {
    console.warn(`  ⚠ ORACLE ${reason}`);
  }
  return penalized;
}

// ── r039/r040 cross-asset confidence penalty ──────────────
// Code enforcement counterpart to buildR039R040CrossAssetNote.
// When ORACLE produces setups from only 1 asset class at high confidence despite
// the prompt requirement, reduce confidence proportionally — same pattern as
// applySetupCountPenalty. Called in runOracleAnalysis after computeOracleConfidence.
export function applyR039R040Penalty(
  confidence: number,
  snapshots: MarketSnapshot[],
  setups: any[],
  isWeekend: boolean
): { penalized: number; reason: string | null } {
  if (isWeekend || confidence < 55) return { penalized: confidence, reason: null };

  function classifySnap(name: string, symbol: string): string {
    const n = (name ?? "").toLowerCase();
    const s = (symbol ?? "").toLowerCase().replace(/[^a-z]/g, "");
    if (["bitcoin","ethereum","btc","eth","bnb","sol","ada","dot","link","xrp","matic","avax"].some(t => n.includes(t) || s.includes(t))) return "crypto";
    if (["nasdaq","nas100","s&p","spx","dow","djia","dax","ftse","nikkei"].some(t => n.includes(t) || s.includes(t))) return "indices";
    if (["gold","silver","oil","crude","copper","natgas","platinum","xau","xag"].some(t => n.includes(t) || s.includes(t))) return "commodities";
    return "forex";
  }

  const classesWithBigMoves = new Set<string>();
  for (const s of snapshots) {
    if (Math.abs(s.changePercent ?? 0) >= 2) {
      classesWithBigMoves.add(classifySnap(s.name, s.symbol));
    }
  }

  const setupClasses = new Set<string>();
  for (const s of setups) {
    setupClasses.add(classifySnap(s.instrument ?? "", s.instrument ?? ""));
  }

  const r039Triggers = classesWithBigMoves.size >= 3;
  const r040Triggers = confidence >= 60;

  if (!r039Triggers && !r040Triggers) return { penalized: confidence, reason: null };
  if (setupClasses.size >= 2) return { penalized: confidence, reason: null };

  const penalty = r040Triggers ? 15 : 10;
  const penalized = Math.max(35, confidence - penalty);
  const rule = r039Triggers && r040Triggers ? "r039+r040" : r039Triggers ? "r039" : "r040";
  const coveredClass = setupClasses.size === 0 ? "no" : [...setupClasses][0];
  return {
    penalized,
    reason: `${rule} cross-asset enforcement: ${confidence}% confidence, setups cover only ${coveredClass} — reduced by ${penalty}pts to ${penalized}%`,
  };
}

// ── r041 screening validation auto-inject ─────────────────
// Code enforcement: when confidence > 55 and ORACLE omitted the mandatory
// 'Screening validation:' line, auto-inject a stub from market snapshot data.
// Prevents post-hoc validation warnings from being the only enforcement mechanism.
export function enforceR041ScreeningValidation(
  analysis: string,
  snapshots: MarketSnapshot[],
  confidence: number
): string {
  if (confidence <= 55) return analysis;
  if (/screening validation:/i.test(analysis)) return analysis;

  const r041Instruments = [
    { label: "EUR/USD", matchers: ["eur/usd", "eurusd"] },
    { label: "GBP/USD", matchers: ["gbp/usd", "gbpusd"] },
    { label: "NASDAQ",  matchers: ["nasdaq", "nas100"] },
    { label: "S&P",     matchers: ["s&p", "spx", "s&p 500"] },
    { label: "BTC",     matchers: ["bitcoin", "btc"] },
    { label: "ETH",     matchers: ["ethereum", "eth"] },
    { label: "Gold",    matchers: ["gold", "xau"] },
    { label: "Oil",     matchers: ["oil", "crude"] },
  ];

  const parts: string[] = [];
  for (const instr of r041Instruments) {
    const snap = snapshots.find(s => {
      const n = (s.name ?? "").toLowerCase();
      const sym = (s.symbol ?? "").toLowerCase();
      return instr.matchers.some(m => n.includes(m) || sym.includes(m));
    });
    if (snap) {
      parts.push(`${instr.label} ${snap.price}`);
    }
  }

  if (parts.length === 0) return analysis;

  const injected = `Screening validation: ${parts.join(", ")}`;
  console.warn(`  ⚠ ORACLE r041: screening validation missing at ${confidence}% confidence — auto-injected`);
  return `${analysis}\n${injected}`;
}

// ── ICT setup type reclassifier ───────────────────────────
// Code enforcement: when ORACLE types a setup as "Other", attempt to reclassify
// it to the correct ICT pattern by matching keywords in the description.
// Priority: specific patterns (FVG, OB, CISD, PDH/PDL, Liquidity Sweep) before
// MSS (which is the broadest structure-based catch-all).
// Root cause of sessions #176-#177, #185: ORACLE uses "Other" as default instead
// of selecting the matching ICT label from the prompt schema.
export function reclassifyOtherSetups(setups: any[]): any[] {
  const rules: Array<{ type: string; patterns: RegExp }> = [
    { type: "FVG",            patterns: /fair\s+value\s+gap|fvg\b|imbalance/i },
    { type: "OB",             patterns: /order\s+block|\bob\b|mitigation\s+block|institutional\s+(level|order)/i },
    { type: "CISD",           patterns: /\bcisd\b|change\s+in\s+state\s+of\s+delivery|displacement\s+candle/i },
    { type: "Liquidity Sweep",patterns: /liquidity\s+sweep|stop\s+hunt|liquidity\s+grab|equal\s+highs|equal\s+lows|sell.?side\s+liquidity|buy.?side\s+liquidity|oversold.{0,100}(bounce|reversal|reversion|recovery)|(extreme|severe).{0,20}(decline|collapse|drop|fall).{0,60}(bounce|reversal)|(supply|demand)\s+shock.{0,20}(exhaustion|bounce|reversal)/i },
    // High-priority MSS: continuation/momentum patterns must fire BEFORE PDH/PDL
    // so "USD strength continuation ... targeting support" goes to MSS, not PDH/PDL.
    // Also catches "\bmomentum\b" descriptions like "driving momentum above X, targeting Y resistance"
    // before PDH/PDL's "targeting ... resistance" can steal them.
    { type: "MSS",            patterns: /\b(momentum|strength|weakness|trend)\s+continuation\b|\bmomentum\b/i },
    { type: "PDH/PDL",        patterns: /\bpdh\b|\bpdl\b|previous\s+day\s+high|previous\s+day\s+low|prior\s+day\s+high|prior\s+day\s+low|session\s+(high|low)|psychological\s+(level|support|number)|(approaching|testing|near|rejection\s+from|rejecting)\s+.{0,30}(key\s+|major\s+|critical\s+|psychological\s+)?(resistance|support)|rejection\s+from\s+.{0,20}(high|low)\b|(resistance|support).{0,30}being\s+tested|targeting.{0,40}(support|resistance)|support\s+breakdown|resistance\s+breakdown/i },
    { type: "MSS",            patterns: /market\s+structure\s+shift|structure\s+(break|shift)|structural\s+break|\bmss\b|breakout|breaking\s+(above|below)|break\s+(above|below)/i },
  ];

  return setups.map(setup => {
    if (setup.type !== "Other") return setup;
    const desc = (setup.description ?? "").toLowerCase();
    for (const rule of rules) {
      if (rule.patterns.test(desc)) {
        console.warn(`  ⚠ Setup reclassifier: "${setup.instrument}" Other → ${rule.type} (matched description keywords)`);
        return { ...setup, type: rule.type };
      }
    }
    return setup;
  });
}

// ── r031 cap notation auto-inject ─────────────────────────
// When ORACLE calculated >65% confidence but omitted the mandatory "capped from X%"
// notation (r031), inject it into the analysis text programmatically.
// Called after rawConf is computed in runOracleAnalysis so the notation appears
// in both ORACLE-SETUPS prompt (via parsed.analysis) and the final journal entry.
// Root cause of session #187: 69% calculated, cap notation absent.
export function enforceR031CapNotation(analysis: string, rawConfidence: number): string {
  if (rawConfidence <= 65) return analysis;
  if (/capped\s+(?:from|at|to)\s*\d+%/i.test(analysis)) return analysis;

  const notation = ` (capped from ${rawConfidence}% due to calibration discipline per r031)`;
  const patched = analysis.replace(
    /(Confidence:\s*\d+%[^\n]*)/i,
    `$1${notation}`
  );
  if (patched !== analysis) {
    console.warn(`  ⚠ ORACLE r031: auto-injected cap notation into confidence line (raw ${rawConfidence}% → capped at 65%)`);
    return patched;
  }
  // No confidence line found — append to end
  console.warn(`  ⚠ ORACLE r031: auto-injected cap notation at end of analysis (raw ${rawConfidence}% → capped at 65%)`);
  return `${analysis}\nCapped from ${rawConfidence}% due to calibration discipline per r031.`;
}

// ── r041 screening validation enforcement ─────────────────
// Returns a prompt block requiring ORACLE to include a "Screening validation:"
// line in its analysis text when confidence exceeds 55% on weekday sessions.
// Injected into ORACLE-ANALYSIS prompt (pre-construction) so the requirement
// ── r011 assumption pre-commitment note ───────────────────
// Injected into ORACLE-ANALYSIS prompt before generation so ORACLE documents
// BOTH external event attributions AND internal soft analytical assertions
// (e.g. "suggests underlying strength", "indicates defensive rotation") in
// assumptions[]. Post-hoc validate.ts warnings (PR #100) fire after generation
// and cannot change already-committed output.
// Root cause of sessions #212-#214: inline r011 text only mentioned "unverified
// external events", so internal analytical attribution phrases like "suggests",
// "indicates", "reflects" were written without assumptions[] entries.
export function buildR011AssumptionNote(): string {
  return `5. ASSUMPTIONS (r011 — MANDATORY): List EVERY causal attribution in the "assumptions" array.
   This includes:
   - External event attributions: geopolitical events, central bank actions, earnings, macro releases
   - Internal analytical assertions: any phrase like "suggests", "indicates", "reflects", "driven by",
     "due to", or "consistent with" that attributes a price move to a cause not directly proven by price data
   - BAD (external): weaving "Iran war escalation driving oil surge" into the narrative without documenting it
   - BAD (internal): "NASDAQ suggests underlying strength" or "EUR/USD indicates defensive rotation" without
     listing those interpretations in assumptions[]
   - GOOD: list every attribution in assumptions[], then reference it in the narrative as "(see assumptions)"
   - Use [] ONLY when every move is described purely as price structure with zero interpretive attribution.
     When in doubt, list it.`;
}

// ── r044 weekend structural depth note ────────────────────
// Injected into ORACLE-ANALYSIS on weekend sessions when sector divergence >1.0%
// between infrastructure tokens (BNB, SOL) and utility tokens (XRP, ADA, LINK).
// Root cause: sessions #212-#214 produced surface-level percentage analysis
// without order flow, volume clusters, or catalyst context despite >1% divergence.
export function buildR044DepthNote(snapshots: MarketSnapshot[], isWeekend: boolean): string {
  if (!isWeekend || !snapshots.length) return "";

  const infraIds  = ["bnb", "binancecoin", "sol", "solana"];
  const utilityIds = ["xrp", "ripple", "ada", "cardano", "link", "chainlink"];

  function matches(s: MarketSnapshot, ids: string[]): boolean {
    const n   = s.name.toLowerCase();
    const sym = s.symbol.toLowerCase().replace(/[^a-z]/g, "");
    return ids.some(t => n.includes(t) || sym.includes(t));
  }

  const infraSnaps   = snapshots.filter(s => matches(s, infraIds));
  const utilitySnaps = snapshots.filter(s => matches(s, utilityIds));
  if (!infraSnaps.length || !utilitySnaps.length) return "";

  const infraAvg   = infraSnaps.reduce((sum, s) => sum + (s.changePercent ?? 0), 0) / infraSnaps.length;
  const utilityAvg = utilitySnaps.reduce((sum, s) => sum + (s.changePercent ?? 0), 0) / utilitySnaps.length;
  const divergence = Math.abs(infraAvg - utilityAvg);
  if (divergence <= 1.0) return "";

  const sign = (v: number) => v >= 0 ? "+" : "";
  const infraStr   = infraSnaps.map(s => `${s.name} ${sign(s.changePercent ?? 0)}${(s.changePercent ?? 0).toFixed(1)}%`).join(", ");
  const utilityStr = utilitySnaps.map(s => `${s.name} ${sign(s.changePercent ?? 0)}${(s.changePercent ?? 0).toFixed(1)}%`).join(", ");

  return `
SECTOR DIVERGENCE DETECTED (r044 — MANDATORY STRUCTURAL DEPTH):
Infrastructure tokens (${infraStr}) vs utility tokens (${utilityStr}) diverge by ${divergence.toFixed(1)}% — exceeds 1.0% threshold.
Your analysis MUST document:
  1. ORDER FLOW: Identify rejection levels and volume clusters for the diverging groups
  2. HISTORICAL PRECEDENT: Reference comparable divergence magnitude and what followed
  3. CATALYST ASSESSMENT: Identify regulatory, institutional, or technical driver
Superficial percentage comparisons without this structural context constitute an r044 depth violation.
`;
}

// ── r041 screening validation note ────────────────────────
// is active before setup generation begins — not post-hoc like validateOracleOutput.
// Root cause of sessions #168-#172: ORACLE omitted the mandatory prefix despite
// having the analytical information to produce it.
export function buildR041ScreeningNote(): string {
  return `
5. SCREENING VALIDATION (r041 — MANDATORY when your confidence exceeds 55%):
   At the end of your Technical Confluence Analysis section, add a line in EXACTLY this format:
   "Screening validation: EUR/USD [price] [level], GBP/USD [price] [level], NASDAQ [price] [level], S&P [price] [level], BTC [price] [level], ETH [price] [level], Gold [price] [level], Oil [price] [level]"
   Replace [price] with the current instrument price and [level] with the key support/resistance level you identified.
   If your confidence is ≤55%, you may omit this line.
   This line is required BEFORE you proceed to any other content.
`;
}

// ── r039/r040 cross-asset coverage requirement ────────────
// Returns a prompt block requiring ORACLE to span ≥2 asset classes when:
//   r039: confidence ≥55% AND 3+ asset classes each have an instrument moving >2%
//   r040: confidence ≥60% with any market conditions
// Injected into ORACLE-SETUPS prompt pre-construction so ORACLE knows before
// committing to setups — not caught post-hoc by validateOracleOutput.
// Root cause of sessions #181-#183: ORACLE produced only forex setups at 67%
// confidence despite indices, crypto, and commodities all moving >2%.
export function buildR039R040CrossAssetNote(snapshots: MarketSnapshot[], confidence: number): string {
  if (confidence < 55) return "";

  function classifySnap(name: string, symbol: string): string {
    const n = (name ?? "").toLowerCase();
    const s = (symbol ?? "").toLowerCase().replace(/[^a-z]/g, "");
    if (["bitcoin","ethereum","btc","eth","bnb","sol","ada","dot","link","xrp","matic","avax"].some(t => n.includes(t) || s.includes(t))) return "crypto";
    if (["nasdaq","nas100","s&p","spx","dow","djia","dax","ftse","nikkei"].some(t => n.includes(t) || s.includes(t))) return "indices";
    if (["gold","silver","oil","crude","copper","natgas","platinum","xau","xag"].some(t => n.includes(t) || s.includes(t))) return "commodities";
    return "forex";
  }

  const classesWithBigMoves = new Set<string>();
  for (const s of snapshots) {
    if (Math.abs(s.changePercent ?? 0) >= 2) {
      classesWithBigMoves.add(classifySnap(s.name, s.symbol));
    }
  }

  const r039Triggers = classesWithBigMoves.size >= 3;
  const r040Triggers = confidence >= 60;

  if (!r039Triggers && !r040Triggers) return "";

  const rules = r039Triggers && r040Triggers ? "r039 + r040" : r039Triggers ? "r039" : "r040";
  const movingClasses = [...classesWithBigMoves].join(", ");
  const coordinatedContext = r039Triggers
    ? ` with ${classesWithBigMoves.size} asset classes moving >2% (${movingClasses})`
    : "";

  return `
CROSS-ASSET COVERAGE REQUIREMENT (${rules} — MANDATORY):
Your confidence is ${confidence}%${coordinatedContext}.
You MUST either:
  (1) Include setups from AT LEAST 2 DIFFERENT asset classes (forex, indices, crypto, commodities), OR
  (2) For each asset class NOT covered by a setup, explicitly reject it with quantified reasons:
      • Poor RR (<1.3) at the identified structural level
      • Stop distance >2% required
      • Conflicting higher timeframe structure
Submitting only forex setups when indices, crypto, and commodities are all moving is a RULE VIOLATION.
`;
}

// ── r041 execution force note ─────────────────────────────
// When ORACLE has already documented structural levels in a Screening validation
// block (ORACLE-ANALYSIS), inject a CRITICAL note into ORACLE-SETUPS requiring
// it to either construct a setup or provide an explicit inline rejection reason
// per instrument. Prevents the session #188 pattern where levels were documented
// but zero setups were constructed.
export function buildExecutionForceNote(analysis: string, confidence: number): string {
  if (confidence < 55) return "";
  if (!/screening validation:/i.test(analysis)) return "";

  return `
EXECUTION REQUIREMENT (r041 — MANDATORY):
Your analysis already contains a Screening validation block listing specific structural levels.
For EACH instrument in that block you MUST do ONE of:
  (a) Construct a COMPLETE setup: entry, stop, target, RR, timeframe with direction "bullish" or "bearish"
  (b) Include a "neutral" entry whose description states the EXACT rejection reason:
      - "Poor RR: entry [PRICE], target [LEVEL] yields only X.X RR — below minimum 1.3"
      - "Stop distance: structural stop requires X.X% which exceeds 2% maximum"
      - "Conflicting timeframe: [LEVEL] identified but higher timeframe trend conflicts"
Documenting structural levels then returning zero non-neutral setups without rejection reasons
is an execution failure (r041). The screening validation block is not a substitute for setup construction.
`;
}

// ── Oil enforcement note ───────────────────────────────────
// When Oil moves ≥5% AND confidence ≥55%, ORACLE must explicitly evaluate Oil —
// either construct a setup or provide a written rejection reason.
// Root cause: sessions #201-#203 each had Oil move 5-8% but received no setup
// because generic screening notes didn't call out Oil specifically.
export function buildOilEnforcementNote(snapshots: MarketSnapshot[], confidence: number): string {
  if (confidence < 55) return "";

  const oilSnap = snapshots.find(s => {
    const n = (s.name ?? "").toLowerCase();
    const sym = (s.symbol ?? "").toLowerCase();
    return n.includes("oil") || n.includes("crude") || sym.includes("cl=") || sym.includes("usoil") || sym.includes("wti");
  });

  if (!oilSnap) return "";
  if (Math.abs(oilSnap.changePercent ?? 0) < 5) return "";

  const pct = Math.abs(oilSnap.changePercent ?? 0).toFixed(2);
  const direction = (oilSnap.changePercent ?? 0) > 0 ? "bullish (surge)" : "bearish (crash)";

  return `
OIL COVERAGE REQUIREMENT (r026 exceptional coordination — MANDATORY):
Crude Oil has moved ${pct}% this session (${direction}) — an exceptional commodity move.
At confidence ${confidence}%, you MUST include one of the following for Crude Oil:
  (a) A COMPLETE setup: entry, stop, target, RR ≥ 1.3, timeframe, direction "bullish" or "bearish", OR
  (b) An EXPLICIT written rejection in the Oil slot description stating the exact reason:
      - "Stop distance: structural stop requires X.X% which exceeds 2% maximum"
      - "Poor RR: entry [PRICE], target [LEVEL] yields only X.X RR — below 1.3 minimum"
      - "Conflicting structure: [LEVEL] identified but higher timeframe trend invalidates setup"
Omitting Crude Oil without a written rejection is an execution gap — exceptional moves require explicit evaluation.
`;
}

// ── Large mover coverage enforcement ──────────────────────
// When any instrument moves ≥3% AND confidence ≥55%, ORACLE must explicitly
// evaluate that instrument — either construct a complete setup (R:R ≥1.3) or
// provide a written rejection with exact price math.
// Root cause: sessions #217-#220 had oil +3.44%, silver -3.84%, platinum -3.83%,
// XRP -3.37% all left as null/neutral without written rejections, producing only
// 1 valid setup at 58% confidence and triggering r026/r039/r041 violations.
export function buildLargeMoverCoverageNote(snapshots: MarketSnapshot[], confidence: number): string {
  if (confidence < 55) return "";
  const largeMovers = snapshots.filter(s => Math.abs(s.changePercent ?? 0) >= 3);
  if (largeMovers.length === 0) return "";

  const lines: string[] = [
    "",
    `LARGE MOVER COVERAGE REQUIREMENT (confidence ${confidence}% — MANDATORY):`,
    `The following instruments moved ≥3% this session. Each MUST have either a complete setup OR a written rejection:`,
  ];
  for (const s of largeMovers) {
    const pct = (s.changePercent ?? 0);
    const sign = pct > 0 ? "+" : "";
    lines.push(`  • ${s.name}: ${sign}${pct.toFixed(2)}% — provide (a) entry/stop/target/RR ≥1.3 setup, OR (b) written rejection: "Rejected: entry [X], stop [Y], nearest target [Z] gives R:R [W] — below 1.3 minimum"`);
  }
  lines.push(`Returning null/neutral for large movers without a written rejection is an execution failure.`);
  return lines.join("\n");
}

// ── RR self-check enforcement ──────────────────────────────
// Returns a prompt block with the explicit RR formula and a mandatory
// self-verification step. Injected into every setup construction prompt
// to prevent ORACLE from self-reporting RR without computing the formula.
// Root cause of session #169: EUR/USD self-reported RR 1.53, actual 0.81.
export function buildRRSelfCheckNote(): string {
  return `
MANDATORY RR VERIFICATION — compute before submitting each setup:
  Bullish: RR = (target − entry) / (entry − stop)
  Bearish: RR = (entry − target) / (stop − entry)
Calculate this value explicitly for every setup. If RR < 1.3, either:
  (a) adjust target to a further liquidity level to achieve RR ≥ 1.3, OR
  (b) reject the setup and leave entry/stop/target as null.
Do NOT submit a setup with self-reported RR that you have not verified with this formula.
`;
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
