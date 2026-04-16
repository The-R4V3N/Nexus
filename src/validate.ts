// ============================================================
// NEXUS — Session Output Validators
// Quality gates that catch bad output before it's committed
// ============================================================

import * as fs from "fs";
import * as path from "path";
import { MEMORY_DIR } from "./utils";
import type { OracleAnalysis, JournalEntry } from "./types";

const FAILURES_PATH   = path.join(MEMORY_DIR, "failures.json");
const MAX_FAILURES    = 20;

// ── Interfaces ────────────────────────────────────────────

export interface ValidationResult {
  valid: boolean;      // false = skip this phase entirely
  warnings: string[];  // logged but don't block
  errors: string[];    // caused valid=false
}

export interface SessionFailure {
  sessionNumber: number;
  timestamp: string;
  phase: "oracle" | "axiom" | "forge" | "journal";
  errors: string[];
  warnings: string[];
  action: "skipped" | "fallback" | "reverted";
}

// ── Stop words for similarity calculation ─────────────────

const STOP_WORDS = new Set([
  "the", "a", "an", "is", "are", "was", "were", "this", "that",
  "with", "for", "and", "but", "or", "not", "in", "on", "at",
  "to", "of", "by", "from", "as",
]);

// ── Text similarity (Jaccard on word sets) ────────────────

export function calculateTextSimilarity(text1: string, text2: string): number {
  if (!text1 || !text2) return 0;

  const toWords = (t: string): Set<string> => {
    const words = t
      .toLowerCase()
      .split(/\s+/)
      .filter((w) => w.length > 0 && !STOP_WORDS.has(w));
    return new Set(words);
  };

  const set1 = toWords(text1);
  const set2 = toWords(text2);

  if (set1.size === 0 && set2.size === 0) return 1;
  if (set1.size === 0 || set2.size === 0) return 0;

  let intersection = 0;
  for (const word of set1) {
    if (set2.has(word)) intersection++;
  }

  const union = set1.size + set2.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

// ── Confidence extraction from analysis text ─────────────

export function extractConfidenceFromText(text: string): number | null {
  // Pattern 0: explicit cap notation — ORACLE may calculate 70% but state "capped at 65%".
  // Prefer the capped (final) value over the raw calculated value.
  const capMatch = text.match(/capped\s+(?:at|to)\s*(\d+)%/i);
  if (capMatch) {
    return parseInt(capMatch[1], 10);
  }

  // Pattern 1: "Confidence: X%" or "Confidence: X% —"
  const directMatch = text.match(/Confidence:\s*(\d+)%/i);
  if (directMatch) {
    return parseInt(directMatch[1], 10);
  }

  // Pattern 2: "TC (X%), MA (Y%), RR (Z%)" — compute weighted average
  const componentMatch = text.match(/TC\s*\((\d+)%\).*?MA\s*\((\d+)%\).*?RR\s*\((\d+)%\)/i);
  if (componentMatch) {
    const tc = parseInt(componentMatch[1], 10);
    const ma = parseInt(componentMatch[2], 10);
    const rr = parseInt(componentMatch[3], 10);
    return Math.round(tc * 0.4 + ma * 0.3 + rr * 0.3);
  }

  return null;
}

// ── Confidence resolution ────────────────────────────────

export function resolveConfidence(analysis: string, jsonConfidence: number): number {
  // Honor explicit cap notation regardless of the 10-point threshold.
  // When ORACLE says "capped at 65%" but returns 70 in JSON, the cap wins.
  const capMatch = analysis.match(/capped\s+(?:at|to)\s*(\d+)%/i);
  if (capMatch) {
    const cappedValue = parseInt(capMatch[1], 10);
    if (cappedValue < jsonConfidence) {
      return cappedValue;
    }
  }

  const textConfidence = extractConfidenceFromText(analysis);
  if (textConfidence !== null && Math.abs(textConfidence - jsonConfidence) > 10) {
    return textConfidence;
  }
  return jsonConfidence;
}

// ── Setup count penalty (backlog #13) ────────────────────────
// Applies a proportional confidence reduction when ORACLE produces fewer setups
// than the minimum required for its stated confidence level.
// Replaces the old hard-cap of Math.min(confidence, 45) which always produced
// 45% regardless of how close to the threshold the session was.
//
// Thresholds (weekday):
//   confidence > 70% → 4 setups required
//   confidence > 50% → 3 setups required
//   confidence ≤ 50% → no minimum
// Weekend: always 2 setups minimum.
// Penalty: 10 points per missing setup, floor at 35%.

export function applySetupCountPenalty(
  confidence: number,
  setupCount: number,
  isWeekend: boolean
): { penalized: number; reason: string | null } {
  const minSetups = isWeekend
    ? 2
    : confidence > 70 ? 4 : confidence > 50 ? 3 : 0;

  if (minSetups > 0 && setupCount < minSetups) {
    const shortfall = minSetups - setupCount;
    const penalized = Math.max(35, confidence - shortfall * 10);
    return {
      penalized,
      reason: `setup-count enforcement: ${setupCount}/${minSetups} required setups — confidence reduced from ${confidence}% by ${shortfall * 10}pts to ${penalized}%`,
    };
  }
  return { penalized: confidence, reason: null };
}

// ── Weekend Crypto Screening Validator ───────────────────
// Checks which available crypto instruments ORACLE actually covered
// (mentioned in analysis text or produced a setup for). Weekend sessions
// must evaluate every instrument fetched from Binance.

export interface WeekendScreeningResult {
  covered: string[];       // instruments with a valid setup or key level
  mentionedOnly: string[]; // instruments in analysis text only — no setup or key level produced
  missing: string[];       // instruments completely ignored
}

export function validateWeekendCryptoScreening(
  oracle: OracleAnalysis,
  availableSnapshots: import("./types").MarketSnapshot[]
): WeekendScreeningResult {
  const analysisText = (oracle.analysis ?? "").toLowerCase();

  // Build set of all instrument tokens mentioned in setups
  const setupTokens = new Set<string>();
  for (const s of oracle.setups) {
    const raw = (s.instrument ?? "").toLowerCase();
    setupTokens.add(raw);
    // Strip common suffixes so "BTCUSDT" → "btc", "BTC/USD" → "btc"
    setupTokens.add(raw.replace(/[/-]?usd[t]?$/, "").trim());
  }

  // Also collect instrument names from key levels — having a key level means
  // ORACLE evaluated the instrument even if no trade setup was produced
  const keyLevelTokens = new Set<string>();
  for (const kl of (oracle.keyLevels ?? [])) {
    const raw = ((kl as any).instrument ?? "").toLowerCase();
    keyLevelTokens.add(raw);
    keyLevelTokens.add(raw.replace(/[/-]?usd[t]?$/, "").trim());
  }

  const covered: string[] = [];
  const mentionedOnly: string[] = [];
  const missing: string[] = [];

  for (const snap of availableSnapshots) {
    const name   = snap.name.toLowerCase();
    const symbol = snap.symbol.toLowerCase()
      .replace(/-usd[t]?$/, "").replace(/usd[t]?$/, "").trim();

    const inAnalysis  = analysisText.includes(name) || analysisText.includes(symbol);
    const inSetup     = setupTokens.has(name) || setupTokens.has(symbol) ||
      [...setupTokens].some(t => t.includes(symbol) || t.includes(name));
    const inKeyLevels = keyLevelTokens.has(name) || keyLevelTokens.has(symbol) ||
      [...keyLevelTokens].some(t => t.includes(symbol) || t.includes(name));

    if (inSetup || inKeyLevels) {
      covered.push(snap.name);
    } else if (inAnalysis) {
      mentionedOnly.push(snap.name);
    } else {
      missing.push(snap.name);
    }
  }

  return { covered, mentionedOnly, missing };
}

// ── Asset class classifier (shared by r039 and r040) ─────

function classifyInstrument(name: string, symbol: string): string {
  const n = (name ?? "").toLowerCase();
  const s = (symbol ?? "").toLowerCase().replace(/[^a-z]/g, "");
  const cryptoTokens = ["bitcoin","ethereum","btc","eth","bnb","sol","ada","dot","link","xrp","matic","avax","cardano","polkadot","chainlink"];
  const indexTokens  = ["nasdaq","nas100","s&p","spx","dow","djia","dax","ftse","nikkei","cac","ibex","russell"];
  const commodTokens = ["gold","silver","oil","crude","copper","natgas","wheat","platinum","xau","xag"];
  if (cryptoTokens.some(t => n.includes(t) || s.includes(t))) return "crypto";
  if (indexTokens.some(t => n.includes(t) || s.includes(t)))  return "indices";
  if (commodTokens.some(t => n.includes(t) || s.includes(t))) return "commodities";
  return "forex";
}

// ── ORACLE Validator ──────────────────────────────────────

export function validateOracleOutput(
  oracle: OracleAnalysis,
  previousSessions: JournalEntry[]
): ValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];

  // Analysis text is non-empty and > 200 chars
  if (!oracle.analysis || oracle.analysis.trim().length === 0) {
    errors.push("Analysis text is empty");
  } else if (oracle.analysis.trim().length < 200) {
    errors.push(`Analysis text too short (${oracle.analysis.trim().length} chars, need > 200)`);
  }

  // Confidence is a number between 0 and 100
  if (typeof oracle.confidence !== "number" || isNaN(oracle.confidence)) {
    errors.push("Confidence is not a valid number");
  } else if (oracle.confidence < 0 || oracle.confidence > 100) {
    errors.push(`Confidence out of range: ${oracle.confidence} (must be 0-100)`);
  }

  // Bias overall is one of the valid values
  const validBiases = ["bullish", "bearish", "neutral", "mixed"];
  if (!oracle.bias || !validBiases.includes(oracle.bias.overall)) {
    errors.push(`Invalid bias overall: "${oracle.bias?.overall}" (must be bullish/bearish/neutral/mixed)`);
  }

  // If bias is "mixed", bias.notes must be non-empty
  if (oracle.bias?.overall === "mixed" && (!oracle.bias.notes || oracle.bias.notes.trim().length === 0)) {
    errors.push("Bias is 'mixed' but bias.notes is empty — must explain why");
  }

  // Validate each setup
  if (oracle.setups && Array.isArray(oracle.setups)) {
    for (let i = 0; i < oracle.setups.length; i++) {
      const s = oracle.setups[i];
      const label = `Setup[${i}] ${s.instrument ?? "unknown"}`;

      // Required numeric fields
      if (s.entry != null && (typeof s.entry !== "number" || s.entry <= 0)) {
        errors.push(`${label}: entry must be a positive number (got ${s.entry})`);
      }
      if (s.stop != null && (typeof s.stop !== "number" || s.stop <= 0)) {
        errors.push(`${label}: stop must be a positive number (got ${s.stop})`);
      }
      if (s.target != null && (typeof s.target !== "number" || s.target <= 0)) {
        errors.push(`${label}: target must be a positive number (got ${s.target})`);
      }
      if (s.RR != null && (typeof s.RR !== "number" || s.RR <= 0)) {
        errors.push(`${label}: RR must be a positive number (got ${s.RR})`);
      }
      if (s.RR != null && typeof s.RR === "number" && s.RR > 20) {
        warnings.push(`${label}: implausible RR of ${s.RR} — likely a decimal point error in entry, stop, or target`);
      }

      // Timeframe string
      if (s.timeframe != null && typeof s.timeframe !== "string") {
        errors.push(`${label}: timeframe must be a string`);
      }

      // Entry/stop/target sane relationship (only if all three are present and valid numbers)
      if (
        typeof s.entry === "number" && s.entry > 0 &&
        typeof s.stop === "number" && s.stop > 0 &&
        typeof s.target === "number" && s.target > 0
      ) {
        if (s.direction === "bullish") {
          // Bullish: stop < entry < target
          if (s.stop >= s.entry) {
            warnings.push(`${label}: bullish but stop (${s.stop}) >= entry (${s.entry})`);
          }
          if (s.target <= s.entry) {
            warnings.push(`${label}: bullish but target (${s.target}) <= entry (${s.entry})`);
          }
        } else if (s.direction === "bearish") {
          // Bearish: target < entry < stop
          if (s.stop <= s.entry) {
            warnings.push(`${label}: bearish but stop (${s.stop}) <= entry (${s.entry})`);
          }
          if (s.target >= s.entry) {
            warnings.push(`${label}: bearish but target (${s.target}) >= entry (${s.entry})`);
          }
        }
      }
    }
  }

  // Tight stop warning on extreme volatility days (r029 enforcement)
  // If any snapshot moved ≥5%, stops <1% of entry are almost certainly
  // too narrow to survive normal noise on that instrument.
  const extremeDay = oracle.marketSnapshots?.some(s => Math.abs(s.changePercent) >= 3);
  if (extremeDay && oracle.setups) {
    for (const s of oracle.setups) {
      if (
        typeof s.entry === "number" && s.entry > 0 &&
        typeof s.stop  === "number" && s.stop  > 0
      ) {
        const stopPct = (Math.abs(s.entry - s.stop) / s.entry) * 100;
        if (stopPct < 1) {
          warnings.push(
            `${s.instrument ?? "Setup"}: stop is only ${stopPct.toFixed(2)}% from entry during extreme volatility (≥5% session move) — r029 requires wider stops`
          );
        }
      }
    }
  }

  // Use the higher of oracle.confidence or text-extracted confidence for threshold checks.
  // Guards against cases where ORACLE puts a lower number in the JSON than it stated in text.
  const rawConfidence = extractConfidenceFromText(oracle.analysis ?? "") ?? oracle.confidence;
  const effectiveConfidence = Math.max(
    typeof oracle.confidence === "number" ? oracle.confidence : 0,
    rawConfidence
  );

  // r026: high confidence must produce broad setup coverage
  // When effective confidence > 55%, fewer than 3 setups indicates incomplete screening.
  // When confidence >= 60% on weekday sessions (≥4 r041 instruments present), minimum is 4
  // setups — aligns with buildMinSetupNote which tells ORACLE "≥4 setups when confidence ≥60%".
  // Sessions #172-#173 each produced only 3 setups at 65% confidence without triggering r026.
  if (effectiveConfidence > 55) {
    const setupCount = oracle.setups?.length ?? 0;
    const snapNamesR026 = new Set(
      (oracle.marketSnapshots ?? []).flatMap(s => [
        (s.name ?? "").toLowerCase(),
        (s.symbol ?? "").toLowerCase().replace(/[^a-z]/g, ""),
      ])
    );
    const r026Aliases: string[][] = [
      ["eur/usd", "eurusd", "eur"],
      ["gbp/usd", "gbpusd", "gbp"],
      ["nasdaq", "nas100"],
      ["s&p", "spx", "s&p500", "s&p 500"],
      ["bitcoin", "btc"],
      ["ethereum", "eth"],
      ["gold", "xau"],
      ["oil", "crude", "wti", "brent"],
    ];
    const isWeekdaySession = r026Aliases.filter(aliases =>
      aliases.some(a => [...snapNamesR026].some(n => n.includes(a.replace("/", ""))))
    ).length >= 4;
    const minRequired = isWeekdaySession && effectiveConfidence >= 60 ? 4 : 3;
    if (setupCount < minRequired) {
      warnings.push(
        `r026: confidence ${effectiveConfidence}% with only ${setupCount} setup(s) — ` +
        (isWeekdaySession && effectiveConfidence >= 60
          ? `weekday sessions at ≥60% confidence require minimum 4 setups (buildMinSetupNote threshold)`
          : `high-confidence sessions require systematic screening across all available instruments (minimum 3 setups)`)
      );
    }
  }

  // r034: zero setups with directional/mixed confidence requires level rejection documentation.
  // Uses effective (raw) confidence so calibration cannot bypass this check.
  if (
    effectiveConfidence >= 50 &&
    oracle.bias?.overall !== "neutral" &&
    (oracle.setups?.length ?? 0) === 0
  ) {
    const rejectionMarkers = [
      "poor rr", "poor r:r", "conflicting timeframe", "insufficient confluence",
      "no viable", "rejected", "evaluated", "screened",
      "level evaluated", "structural level", "key level identified",
    ];
    const analysisLower = (oracle.analysis ?? "").toLowerCase();
    const hasRejectionDoc = rejectionMarkers.some(p => analysisLower.includes(p));
    if (!hasRejectionDoc) {
      warnings.push(
        `r034: ${effectiveConfidence}% confidence with ${oracle.bias?.overall} bias produced zero setups ` +
        `but analysis contains no structural level evaluation or rejection reasoning — ` +
        `document which levels were screened and why each was rejected (poor RR, conflicting timeframe, insufficient confluence)`
      );
    }
  }

  // r038: high-conviction sessions require proportional output or documented evaluation.
  // When effective confidence ≥60% with directional/mixed bias, must produce either
  // (1) minimum 2 setups across different asset classes, or (2) evidence in the analysis
  // text that at least 5 specific instruments were evaluated.
  // Uses effective confidence so post-calibration capping cannot bypass this check.
  if (
    effectiveConfidence >= 60 &&
    oracle.bias?.overall !== "neutral"
  ) {
    const setupCount = oracle.setups?.length ?? 0;
    if (setupCount < 2) {
      // Check if analysis documents evaluation of ≥5 instruments by name
      // (instrument names typically appear as ticker or common name patterns)
      const instrumentMentions = (oracle.marketSnapshots ?? []).filter(snap => {
        const name   = snap.name.toLowerCase();
        const symbol = snap.symbol.toLowerCase().replace(/[^a-z]/g, "");
        const text   = (oracle.analysis ?? "").toLowerCase();
        return text.includes(name) || text.includes(symbol);
      }).length;
      if (instrumentMentions < 5) {
        warnings.push(
          `r038: ${effectiveConfidence}% confidence with ${oracle.bias?.overall} bias produced only ${setupCount} setup(s) ` +
          `and analysis references only ${instrumentMentions} instrument(s) — ` +
          `high-conviction sessions require minimum 2 setups or documented evaluation of ≥5 instruments`
        );
      }
    }
  }

  // r039: coordinated market cross-asset screening.
  // When effective confidence ≥55% during coordinated moves (3+ asset classes each with
  // at least one instrument moving >2%), setups must span ≥2 asset classes or each
  // non-covered class must be explicitly rejected with quantified reasoning.
  if (effectiveConfidence >= 55 && oracle.bias?.overall !== "neutral") {

    const snapshots = oracle.marketSnapshots ?? [];
    const classesWithBigMoves = new Set<string>();
    for (const snap of snapshots) {
      if (Math.abs(snap.changePercent) >= 2) {
        classesWithBigMoves.add(classifyInstrument(snap.name, snap.symbol));
      }
    }

    if (classesWithBigMoves.size >= 3) {
      const setupClasses = new Set<string>();
      for (const s of oracle.setups ?? []) {
        setupClasses.add(classifyInstrument(s.instrument ?? "", s.instrument ?? ""));
      }
      if (setupClasses.size < 2) {
        const coveredLabel = setupClasses.size === 0 ? "no" : `only ${[...setupClasses][0]}`;
        warnings.push(
          `r039: ${effectiveConfidence}% confidence with ${classesWithBigMoves.size} asset classes moving >2% — ` +
          `setups cover ${coveredLabel} asset class(es); screening must span multiple classes or explicitly reject each with quantified reasoning (poor RR <1.3, stop >2%, conflicting timeframes)`
        );
      }
    }
  }

  // r040: validation accountability — high-confidence sessions require cross-asset setup
  // diversity OR documented price-level rejection with quantified reasons.
  // Distinct from r038: r040 requires setups from DIFFERENT asset classes (not just any 2),
  // and requires quantified rejection reasons (not just instrument mentions).
  if (effectiveConfidence >= 60 && oracle.bias?.overall !== "neutral") {
    const setupClasses = new Set<string>();
    for (const s of oracle.setups ?? []) {
      setupClasses.add(classifyInstrument(s.instrument ?? "", s.instrument ?? ""));
    }
    const crossAssetCoverage = setupClasses.size >= 2;

    if (!crossAssetCoverage) {
      const analysisLower = (oracle.analysis ?? "").toLowerCase();
      const quantifiedRejectionKeywords = [
        "poor rr", "rr <1.3", "rr<1.3", "stop distance", "stop >2%",
        "conflicting higher timeframe", "conflicting timeframe", "rejected at",
        "no viable entry", "insufficient confluence",
      ];
      const matchedKeywords = quantifiedRejectionKeywords.filter(kw => analysisLower.includes(kw));
      const hasQuantifiedRejection = matchedKeywords.length >= 2;

      if (!hasQuantifiedRejection) {
        const setupClassLabel = setupClasses.size === 0 ? "no" : `only ${[...setupClasses].join("/")}`;
        warnings.push(
          `r040: ${effectiveConfidence}% confidence with ${oracle.bias?.overall} bias — setups cover ${setupClassLabel} asset class(es); ` +
          `requires either (1) ≥2 setups across different asset classes, or (2) documented rejection of ≥5 specific price levels ` +
          `with quantified reasons (poor RR <1.3, stop >2%, conflicting timeframe) across forex/indices/crypto`
        );
      }
    }
  }

  // "Other" type overuse — ICT types should be preferred
  if (oracle.setups && oracle.setups.length > 0) {
    const otherCount = oracle.setups.filter(s => s.type === "Other").length;
    if (otherCount > 0 && otherCount >= oracle.setups.length * 0.5) {
      warnings.push(
        `${otherCount}/${oracle.setups.length} setups use type "Other" — ICT patterns (FVG, OB, Liquidity Sweep, MSS, CISD, PDH/PDL) should be preferred`
      );
    }
  }

  // Confidence mismatch check — compare analysis text vs JSON field
  if (oracle.analysis && typeof oracle.confidence === "number") {
    const textConfidence = extractConfidenceFromText(oracle.analysis);
    if (textConfidence !== null) {
      const diff = Math.abs(textConfidence - oracle.confidence);
      if (diff > 15) {
        warnings.push(
          `Confidence mismatch: analysis text says ${textConfidence}% but JSON field says ${oracle.confidence}%`
        );
      }
    }
  }

  // r031: confidence > 65% requires cap notation in analysis text.
  // Accepts "capped from X%", "capped at X%", or "capped to X%" — all valid forms.
  if (effectiveConfidence > 65) {
    const hasCapNotation = /capped\s+(?:from|at|to)\s*\d+%/i.test(oracle.analysis ?? "");
    if (!hasCapNotation) {
      warnings.push(
        `r031: confidence ${effectiveConfidence}% exceeds 65% cap — analysis must include cap notation e.g. "capped from X%" or "capped at X%" per r031`
      );
    }
  }

  // r036: no bearish risk asset setups during active DXY weakness.
  // DXY weakness = EUR/USD and GBP/USD both up >1% in the same session.
  // Risk assets = indices and crypto (not forex, commodities).
  {
    const forexSnaps = (oracle.marketSnapshots ?? []).filter(s => {
      const n = (s.name ?? "").toLowerCase().replace(/[^a-z/]/g, "");
      const sym = (s.symbol ?? "").toLowerCase().replace(/[^a-z]/g, "");
      return n.includes("eur") || n.includes("gbp") || sym.includes("eurusd") || sym.includes("gbpusd");
    });
    const eurUp  = forexSnaps.some(s => (s.name ?? "").toLowerCase().includes("eur") && (s.changePercent ?? 0) > 1);
    const gbpUp  = forexSnaps.some(s => (s.name ?? "").toLowerCase().includes("gbp") && (s.changePercent ?? 0) > 1);
    const dxyWeak = eurUp && gbpUp;

    if (dxyWeak) {
      const bearishRiskAssets = (oracle.setups ?? []).filter(s => {
        const cls = classifyInstrument(s.instrument ?? "", s.instrument ?? "");
        return s.direction === "bearish" && (cls === "indices" || cls === "crypto");
      });
      if (bearishRiskAssets.length > 0) {
        warnings.push(
          `r036: active DXY weakness (EUR/USD and GBP/USD both >+1%) — bearish risk asset setup(s) detected (${bearishRiskAssets.map(s => s.instrument).join(", ")}); r036 prohibits bearish risk asset setups when EUR/USD, GBP/USD, AUD/USD all up >1%`
        );
      }
    }
  }

  // r041: when confidence >55%, analysis must use the explicit screening validation template.
  // Required format: "Screening validation: EUR/USD [price] [level], GBP/USD [price] [level], ..."
  // Instrument-mention checks are insufficient — the template format itself is the enforcement gate.
  // Only fires on weekday sessions (detected by ≥4 of the 8 instruments in marketSnapshots).
  if (effectiveConfidence > 55) {
    const snapNames = new Set(
      (oracle.marketSnapshots ?? []).flatMap(s => [
        (s.name ?? "").toLowerCase(),
        (s.symbol ?? "").toLowerCase().replace(/[^a-z]/g, ""),
      ])
    );
    const r041Aliases: string[][] = [
      ["eur/usd", "eurusd", "eur"],
      ["gbp/usd", "gbpusd", "gbp"],
      ["nasdaq", "nas100"],
      ["s&p", "spx", "s&p500", "s&p 500"],
      ["bitcoin", "btc"],
      ["ethereum", "eth"],
      ["gold", "xau"],
      ["oil", "crude", "wti", "brent"],
    ];
    const presentCount = r041Aliases.filter(aliases =>
      aliases.some(a => [...snapNames].some(n => n.includes(a.replace("/", ""))))
    ).length;
    if (presentCount >= 4) {
      const analysisLower = (oracle.analysis ?? "").toLowerCase();
      if (!analysisLower.includes("screening validation:")) {
        warnings.push(
          `r041: ${effectiveConfidence}% confidence — analysis must include explicit screening validation template: ` +
          `'Screening validation: EUR/USD [price] [level], GBP/USD [price] [level], NASDAQ [price] [level], ` +
          `S&P [price] [level], BTC [price] [level], ETH [price] [level], Gold [price] [level], Oil [price] [level]'`
        );
      }
    }
  }

  // r011 compliance: causal attribution language must be documented in assumptions[]
  // Catches both explicit causal phrases and softer attribution language ORACLE naturally uses
  const causalPattern = /\b(assuming|if confirmed|driven by|due to|because of|amid geopolit|escalation|de-escalation|suggests?|consistent with|appears? to|following\s+\w*day|amid\b|reflects?|indicates?)\b/i;
  // Also catch cross-asset price references in any session (e.g. "gold surged +8.49%" in a crypto session)
  const crossAssetPattern = /\b(gold|silver|oil|crude|equities|equity|stocks?|bonds?|s&p|nasdaq|dow|dax|ftse|treasury|yields?)\b.*?[\+\-]?\d+\.?\d*%/i;
  const hasCausal = causalPattern.test(oracle.analysis ?? "") || crossAssetPattern.test(oracle.analysis ?? "");
  if (hasCausal) {
    const assumptions = (oracle as any).assumptions;
    if (!Array.isArray(assumptions) || assumptions.length === 0) {
      warnings.push(
        "r011 compliance: analysis contains causal attribution language or cross-asset price references but assumptions[] is empty — unverified events must be listed in the assumptions field"
      );
    }
  }

  // Recycled analysis check — compare against last session
  if (previousSessions.length > 0) {
    const lastSession = previousSessions[previousSessions.length - 1];
    const prevAnalysis = lastSession.fullAnalysis?.analysis;
    if (prevAnalysis && oracle.analysis) {
      const similarity = calculateTextSimilarity(oracle.analysis, prevAnalysis);
      if (similarity > 0.8) {
        warnings.push(
          `Recycled analysis detected: ${(similarity * 100).toFixed(0)}% similar to session #${lastSession.sessionNumber}`
        );
      }
    }
  }

  return {
    valid: errors.length === 0,
    warnings,
    errors,
  };
}

// ── r029 Stop Distance Filter ────────────────────────────
// Hard-removes setups that violate minimum stop distance requirements
// during elevated volatility. This replaces the warn-only behaviour so
// ORACLE cannot silently produce non-compliant setups.
//
// Thresholds (mirrors r029 wording exactly):
//   extreme   : any snapshot |changePercent| ≥ 5  → stop must be ≥ 1.5% from entry
//   moderate  : any snapshot |changePercent| ≥ 3  → stop must be ≥ 1.0% from entry
//   normal    : no filter applied

export interface SetupRemovalRecord {
  instrument: string;
  reason: string;
}

export function filterNonCompliantSetups(oracle: OracleAnalysis): {
  oracle: OracleAnalysis;
  removed: SetupRemovalRecord[];
} {
  const snapshots = oracle.marketSnapshots ?? [];
  const maxMove = snapshots.reduce((max, s) => Math.max(max, Math.abs(s.changePercent)), 0);

  const extremeVolatility = maxMove >= 5;
  const moderateVolatility = maxMove >= 3;

  if (!extremeVolatility && !moderateVolatility) {
    return { oracle, removed: [] };
  }

  const minStopPct = extremeVolatility ? 1.5 : 1.0;
  const volatilityLabel = extremeVolatility ? "extreme" : "moderate";

  const removed: SetupRemovalRecord[] = [];
  const compliantSetups: typeof oracle.setups = [];

  for (const s of oracle.setups) {
    if (
      typeof s.entry === "number" && s.entry > 0 &&
      typeof s.stop  === "number" && s.stop  > 0
    ) {
      const stopPct = (Math.abs(s.entry - s.stop) / s.entry) * 100;
      if (stopPct < minStopPct) {
        removed.push({
          instrument: s.instrument ?? "unknown",
          reason: `r029: stop is ${stopPct.toFixed(2)}% from entry — requires ≥${minStopPct}% during ${volatilityLabel} volatility (session move ${maxMove.toFixed(1)}%)`,
        });
        continue;
      }
    }
    compliantSetups.push(s);
  }

  return {
    oracle: { ...oracle, setups: compliantSetups },
    removed,
  };
}

// ── r036 Setup Filter ────────────────────────────────────
// Hard-removes bearish risk asset setups when active DXY weakness is detected.
// DXY weakness = EUR/USD and GBP/USD both up >1% in the same session.
// Risk assets = indices and crypto (forex and commodities are not filtered).
// Mirrors filterNonCompliantSetups pattern: returns new oracle + removal log.

export function filterR036Setups(oracle: OracleAnalysis): {
  oracle: OracleAnalysis;
  removed: SetupRemovalRecord[];
} {
  const snapshots = oracle.marketSnapshots ?? [];

  const eurUp = snapshots.some(s => {
    const n = (s.name ?? "").toLowerCase();
    const sym = (s.symbol ?? "").toLowerCase().replace(/[^a-z]/g, "");
    return (n.includes("eur") || sym.includes("eurusd")) && (s.changePercent ?? 0) > 1;
  });
  const gbpUp = snapshots.some(s => {
    const n = (s.name ?? "").toLowerCase();
    const sym = (s.symbol ?? "").toLowerCase().replace(/[^a-z]/g, "");
    return (n.includes("gbp") || sym.includes("gbpusd")) && (s.changePercent ?? 0) > 1;
  });

  if (!eurUp || !gbpUp) {
    return { oracle, removed: [] };
  }

  const removed: SetupRemovalRecord[] = [];
  const compliantSetups: typeof oracle.setups = [];

  for (const s of oracle.setups) {
    const cls = classifyInstrument(s.instrument ?? "", s.instrument ?? "");
    if (s.direction === "bearish" && (cls === "indices" || cls === "crypto")) {
      removed.push({
        instrument: s.instrument ?? "unknown",
        reason: `r036: bearish ${cls} setup removed — active DXY weakness (EUR/USD and GBP/USD both >+1%)`,
      });
    } else {
      compliantSetups.push(s);
    }
  }

  return {
    oracle: { ...oracle, setups: compliantSetups },
    removed,
  };
}

// ── AXIOM Rumination Detector ─────────────────────────────
// Detects when AXIOM acknowledges a compliance failure in text but
// takes zero concrete action (no rule update, new rule, or self-task).
// Returns a warning string to surface this, or null if no issue.

const VIOLATION_KEYWORDS = [
  "compliance failure", "compliance violation", "execution gap",
  "systematic failure", "failed to implement", "failed to comply",
  "failed to apply", "failed to execute", "violation", "non-compliant",
  "enforcement mechanisms are inadequate", "need validation logic", "need enforcement mechanism",
  // Extended gap-acknowledgment patterns (backlog #6) — sessions #166-167
  "remains a known gap", "known gap", "requires enforcement", "gap requiring enforcement",
  "enforcement rather than", "requires code enforcement",
];

export function detectAxiomRumination(parsed: {
  whatFailed?: string;
  ruleUpdates?: any[];
  newRules?: any[];
  newSelfTasks?: any[];
}): string | null {
  const failText = (parsed.whatFailed ?? "").toLowerCase();
  if (!failText) return null;

  const hasViolationLanguage = VIOLATION_KEYWORDS.some(kw => failText.includes(kw));
  if (!hasViolationLanguage) return null;

  const hasRuleUpdate  = (parsed.ruleUpdates  ?? []).length > 0;
  const hasNewRule     = (parsed.newRules      ?? []).length > 0;
  const hasSelfTask    = (parsed.newSelfTasks  ?? []).length > 0;

  if (hasRuleUpdate || hasNewRule || hasSelfTask) return null;

  return "AXIOM acknowledged failure without action: compliance failure identified in whatFailed but no rule updates, new rules, or self-tasks were created — a forced self-task will be injected";
}

// ── Acknowledged Gap Detector (backlog #6 second half) ────
// Fires when AXIOM uses explicit DEFERRAL language ("known gap",
// "requires enforcement") — meaning AXIOM is aware of the gap but
// is not fixing it this session — AND takes rule-change action
// (so detectAxiomRumination's force-inject is bypassed) but omits
// a self-task. Without a self-task, the deferred gap has no tracking
// mechanism and will silently repeat every session.

const DEFERRAL_KEYWORDS = [
  "remains a known gap", "known gap", "requires enforcement",
  "gap requiring enforcement", "requires code enforcement",
  "enforcement rather than", "need enforcement mechanism",
  "need validation logic",
];

export function detectAcknowledgedGap(parsed: {
  whatFailed?: string;
  ruleUpdates?: any[];
  newRules?: any[];
  newSelfTasks?: any[];
}): string | null {
  const failText = (parsed.whatFailed ?? "").toLowerCase();
  if (!failText) return null;

  const hasDeferralLanguage = DEFERRAL_KEYWORDS.some(kw => failText.includes(kw));
  if (!hasDeferralLanguage) return null;

  const hasRuleUpdate = (parsed.ruleUpdates ?? []).length > 0;
  const hasNewRule    = (parsed.newRules     ?? []).length > 0;
  const hasSelfTask   = (parsed.newSelfTasks ?? []).length > 0;

  // No action at all — detectAxiomRumination already handles this with a forced injection.
  if (!hasRuleUpdate && !hasNewRule && !hasSelfTask) return null;

  // A self-task exists: the gap is explicitly tracked across sessions.
  if (hasSelfTask) return null;

  // Rule changes were made but no self-task created — the deferred gap goes untracked.
  return "AXIOM explicitly deferred a gap ('known gap'/'requires enforcement') and modified rules without a self-task — the gap will remain untracked across sessions";
}

// ── Bias-to-Rule Mapping Checker ─────────────────────────
// Detects when AXIOM identifies cognitive biases but produces no rule updates
// that address them. Warns so the feedback reaches AXIOM's next context.

function checkBiasRuleMapping(parsed: any): string[] {
  const warnings: string[] = [];
  const biases: string[] = Array.isArray(parsed.cognitiveBiases) ? parsed.cognitiveBiases : [];
  if (biases.length === 0) return warnings;

  const ruleUpdates: any[] = Array.isArray(parsed.ruleUpdates) ? parsed.ruleUpdates : [];
  const newRules: any[] = Array.isArray(parsed.newRules) ? parsed.newRules : [];

  // Collect all text from rule changes that could address a bias
  const ruleTexts: string[] = [
    ...ruleUpdates.map((r: any) => `${r.reason ?? ""} ${r.after ?? ""}`),
    ...newRules.map((r: any) => `${r.description ?? ""}`),
  ].filter(Boolean);

  if (ruleTexts.length === 0) {
    warnings.push(
      `${biases.length} cognitive bias(es) detected (${biases.join(", ")}) but no rule updates or new rules address them — biases must drive concrete rule changes`
    );
    return warnings;
  }

  // Check if any rule text overlaps meaningfully with any bias
  const biasText = biases.join(" ");
  const anyOverlap = ruleTexts.some(
    (ruleText) => calculateTextSimilarity(biasText, ruleText) > 0.1
  );

  if (!anyOverlap) {
    warnings.push(
      `Cognitive bias(es) detected (${biases.join(", ")}) but rule updates don't appear to address them — ensure rule changes target the identified biases`
    );
  }

  return warnings;
}

// ── AXIOM Justification Cross-checker ────────────────────
// Detects when AXIOM's stated reasons contradict measurable session facts.
// Catches fabricated justifications before they corrupt rules.

function checkAxiomJustifications(
  parsed: any,
  oracle: OracleAnalysis
): string[] {
  const warnings: string[] = [];
  const actualSetups = oracle.setups?.length ?? 0;
  const actualConfidence = oracle.confidence;

  // Collect all text AXIOM used to justify rule changes
  const justificationTexts: string[] = [
    parsed.whatFailed ?? "",
    parsed.whatWorked ?? "",
    parsed.evolutionSummary ?? "",
    ...(parsed.ruleUpdates ?? []).map((r: any) => `${r.reason ?? ""} ${r.after ?? ""}`),
  ];

  for (const text of justificationTexts) {
    // Check for setup count overclaims: "4+ quality setups", "5+ setups", etc.
    const setupClaimMatch = text.match(/(\d+)\+\s*(?:quality\s+)?setups?/i);
    if (setupClaimMatch) {
      const claimed = parseInt(setupClaimMatch[1], 10);
      if (actualSetups < claimed) {
        warnings.push(
          `AXIOM justification claims "${setupClaimMatch[0]}" but only ${actualSetups} setup(s) were produced — fabricated justification detected`
        );
      }
    }

    // Check confidence value misrepresentation: "scored only X%" or "only X% confidence"
    const confClaimMatch = text.match(/scored\s+only\s+(\d+)%|only\s+(\d+)%\s+confidence/i);
    if (confClaimMatch) {
      const claimed = parseInt(confClaimMatch[1] ?? confClaimMatch[2], 10);
      if (Math.abs(claimed - actualConfidence) > 10) {
        warnings.push(
          `AXIOM justification references confidence of ${claimed}% but ORACLE actual confidence was ${actualConfidence}% — misrepresented value`
        );
      }
    }
  }

  return warnings;
}

// ── AXIOM Validator ───────────────────────────────────────

export function validateAxiomOutput(
  parsed: any,
  sessionNumber: number,
  previousSessions: JournalEntry[],
  oracle?: OracleAnalysis
): ValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];

  // Required string fields — each non-empty
  for (const field of ["whatWorked", "whatFailed", "evolutionSummary"]) {
    if (!parsed[field] || typeof parsed[field] !== "string" || parsed[field].trim().length === 0) {
      errors.push(`Missing or empty required field: ${field}`);
    }
  }

  // cognitiveBiases is an array
  if (!Array.isArray(parsed.cognitiveBiases)) {
    errors.push("cognitiveBiases must be an array");
  }

  // ruleUpdates is an array (can be empty)
  if (parsed.ruleUpdates !== undefined && !Array.isArray(parsed.ruleUpdates)) {
    errors.push("ruleUpdates must be an array");
  }

  // newRules is an array (can be empty)
  if (parsed.newRules !== undefined && !Array.isArray(parsed.newRules)) {
    errors.push("newRules must be an array");
  }

  // Recycled reflection check — compare evolutionSummary against last session
  if (previousSessions.length > 0 && parsed.evolutionSummary) {
    const lastSession = previousSessions[previousSessions.length - 1];
    const prevEvolution = lastSession.reflection?.evolutionSummary;
    if (prevEvolution) {
      const similarity = calculateTextSimilarity(parsed.evolutionSummary, prevEvolution);
      if (similarity > 0.7) {
        warnings.push(
          `Recycled reflection detected: ${(similarity * 100).toFixed(0)}% similar to session #${lastSession.sessionNumber}`
        );
      }
    }
  }

  // Validate rule update IDs format (r + 3 digits)
  // Also detect rule descriptions that will be truncated by security.ts (MAX_RULE_LENGTH = 500)
  const MAX_RULE_LENGTH = 500;
  if (Array.isArray(parsed.ruleUpdates)) {
    for (const update of parsed.ruleUpdates) {
      if (update.ruleId && !/^r\d{3}$/.test(update.ruleId)) {
        warnings.push(`Rule update references invalid ID format: "${update.ruleId}" (expected r + 3 digits)`);
      }
      if (update.after && update.after.length >= MAX_RULE_LENGTH) {
        warnings.push(
          `Rule update ${update.ruleId} "after" text is ${update.after.length} chars (limit ${MAX_RULE_LENGTH}) — will be truncated by security gate`
        );
      }
    }
  }

  // Cross-check AXIOM's stated justifications against measurable oracle facts
  if (oracle) {
    const justificationWarnings = checkAxiomJustifications(parsed, oracle);
    warnings.push(...justificationWarnings);
    // Fabricated justifications for rule changes are hard errors — block the rule update
    const fabricated = justificationWarnings.filter(w => w.includes("fabricated justification"));
    if (fabricated.length > 0) {
      errors.push(`AXIOM rule update(s) blocked: justification contradicts session data (${fabricated.length} fabrication(s) detected)`);
    }
  }

  // Check that detected cognitive biases are addressed by rule changes
  warnings.push(...checkBiasRuleMapping(parsed));

  // Detect unacted compliance violations (rumination blind spot)
  const ruminationWarning = detectAxiomRumination(parsed);
  if (ruminationWarning) warnings.push(ruminationWarning);

  // Detect explicitly deferred gaps that lack a tracking self-task (backlog #6 second half)
  const gapWarning = detectAcknowledgedGap(parsed);
  if (gapWarning) warnings.push(gapWarning);

  return {
    valid: errors.length === 0,
    warnings,
    errors,
  };
}

// ── Failure logging ───────────────────────────────────────

export function logFailure(failure: SessionFailure): void {
  fs.mkdirSync(MEMORY_DIR, { recursive: true });

  let failures: SessionFailure[] = [];
  try {
    if (fs.existsSync(FAILURES_PATH)) {
      failures = JSON.parse(fs.readFileSync(FAILURES_PATH, "utf-8"));
    }
  } catch {
    failures = [];
  }

  failures.push(failure);

  // Keep only the last MAX_FAILURES entries
  if (failures.length > MAX_FAILURES) {
    failures = failures.slice(failures.length - MAX_FAILURES);
  }

  fs.writeFileSync(FAILURES_PATH, JSON.stringify(failures, null, 2));
}

export function loadRecentFailures(): SessionFailure[] {
  try {
    if (fs.existsSync(FAILURES_PATH)) {
      return JSON.parse(fs.readFileSync(FAILURES_PATH, "utf-8"));
    }
  } catch {
    // Corrupted or missing file
  }
  return [];
}
