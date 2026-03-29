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
  const textConfidence = extractConfidenceFromText(analysis);
  if (textConfidence !== null && Math.abs(textConfidence - jsonConfidence) > 10) {
    return textConfidence;
  }
  return jsonConfidence;
}

// ── Programmatic Confidence Calibration ──────────────────────
// Historical data shows confidence bands are miscalibrated:
//   30-50% band: NEXUS claims ~40% → actual hit rate 57% (underconfident)
//   50-70% band: NEXUS claims ~58% → actual hit rate 17% (severely overconfident)
//   70-85% band: NEXUS claims ~75% → actual hit rate 40% (overconfident)
// This function applies mathematical corrections post-ORACLE.

export function applyCalibrationAdjustment(
  rawConfidence: number,
  biasOverall: string
): number {
  // Only adjust the miscalibrated bands (30-70)
  // Outside these bands, not enough data to calibrate
  if (rawConfidence < 30 || rawConfidence >= 70) {
    return rawConfidence;
  }

  let adjusted = rawConfidence;

  if (rawConfidence >= 50 && rawConfidence < 70) {
    // 50-70% band: severely overconfident (claims 58%, actual 17%)
    // Base penalty: reduce by 15 points
    // Mixed bias gets extra penalty (correlation breakdown = even worse hit rate)
    const basePenalty = 15;
    const mixedExtra = biasOverall === "mixed" ? 5 : 0;
    adjusted = rawConfidence - basePenalty - mixedExtra;
  } else if (rawConfidence >= 30 && rawConfidence < 50) {
    // 30-50% band: underconfident (claims 40%, actual 57%)
    // Boost by 8 points to better reflect actual performance
    adjusted = rawConfidence + 8;
  }

  // Clamp to valid range
  return Math.round(Math.max(0, Math.min(100, adjusted)));
}

// ── Weekend Crypto Screening Validator ───────────────────
// Checks which available crypto instruments ORACLE actually covered
// (mentioned in analysis text or produced a setup for). Weekend sessions
// must evaluate every instrument fetched from Binance.

export interface WeekendScreeningResult {
  covered: string[];   // instruments mentioned in analysis or setups
  missing: string[];   // instruments completely ignored
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

  const covered: string[] = [];
  const missing: string[] = [];

  for (const snap of availableSnapshots) {
    const name   = snap.name.toLowerCase();                    // "bitcoin"
    const symbol = snap.symbol.toLowerCase()                   // "btc-usd" → "btc"
      .replace(/-usd[t]?$/, "").replace(/usd[t]?$/, "").trim();

    const inAnalysis = analysisText.includes(name) || analysisText.includes(symbol);
    const inSetup    = setupTokens.has(name) || setupTokens.has(symbol) ||
      [...setupTokens].some(t => t.includes(symbol) || t.includes(name));

    if (inAnalysis || inSetup) {
      covered.push(snap.name);
    } else {
      missing.push(snap.name);
    }
  }

  return { covered, missing };
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

// ── AXIOM Validator ───────────────────────────────────────

export function validateAxiomOutput(
  parsed: any,
  sessionNumber: number,
  previousSessions: JournalEntry[]
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
  if (Array.isArray(parsed.ruleUpdates)) {
    for (const update of parsed.ruleUpdates) {
      if (update.ruleId && !/^r\d{3}$/.test(update.ruleId)) {
        warnings.push(`Rule update references invalid ID format: "${update.ruleId}" (expected r + 3 digits)`);
      }
    }
  }

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
