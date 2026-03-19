// ============================================================
// NEXUS — Shared Utilities
// Common helpers used across multiple modules
// ============================================================

import * as path from "path";

// ── Path constants ───────────────────────────────────────────

export const MEMORY_DIR          = path.join(process.cwd(), "memory");
export const ANALYSIS_RULES_PATH = path.join(MEMORY_DIR, "analysis-rules.json");
export const SYSTEM_PROMPT_PATH  = path.join(MEMORY_DIR, "system-prompt.md");

// ── JSON salvage helper ──────────────────────────────────────
// Attempts to repair truncated/malformed JSON by closing
// dangling strings, brackets, and braces.

export function salvageJSON(text: string): any | null {
  let attempt = text;

  const openBraces    = (attempt.match(/{/g)  || []).length;
  const closeBraces   = (attempt.match(/}/g)  || []).length;
  const openBrackets  = (attempt.match(/\[/g) || []).length;
  const closeBrackets = (attempt.match(/]/g)  || []).length;

  // Close any dangling string — only when text ends mid-string
  // (last quote is an opener with no matching closer)
  const quoteCount = (attempt.match(/"/g) || []).length;
  if (quoteCount % 2 !== 0) {
    // Odd number of quotes means an unclosed string
    attempt += '"';
  }

  attempt = attempt.replace(/,\s*$/, '');

  for (let i = 0; i < openBrackets - closeBrackets; i++) attempt += ']';
  for (let i = 0; i < openBraces   - closeBraces;   i++) attempt += '}';

  try   { return JSON.parse(attempt); }
  catch { return null; }
}

// ── Strip lone surrogates ────────────────────────────────────
// Removes unpaired UTF-16 surrogates that break JSON
// serialization and can cause API 400 errors.

export function stripSurrogates(str: string): string {
  return str.replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, "");
}

// ── Extract JSON from API response ───────────────────────────
// Strips markdown fences, finds the outermost { ... } block,
// and returns just the JSON text.

export function extractJSONFromResponse(rawText: string): string {
  let jsonText = rawText.replace(/```json\n?|```\n?/g, "").trim();

  // Detect whether the response is a JSON array or object
  const firstBrace   = jsonText.indexOf("{");
  const firstBracket = jsonText.indexOf("[");

  // Choose the earlier delimiter — array or object
  const isArray = firstBracket !== -1 && (firstBrace === -1 || firstBracket < firstBrace);

  if (isArray) {
    const lastBracket = jsonText.lastIndexOf("]");
    if (firstBracket !== -1 && lastBracket !== -1 && lastBracket > firstBracket) {
      if (firstBracket > 0 || lastBracket < jsonText.length - 1) {
        jsonText = jsonText.slice(firstBracket, lastBracket + 1);
      }
    }
  } else {
    const lastBrace = jsonText.lastIndexOf("}");
    if (firstBrace > 0 || (lastBrace !== -1 && lastBrace < jsonText.length - 1)) {
      if (firstBrace !== -1 && lastBrace !== -1 && lastBrace > firstBrace) {
        jsonText = jsonText.slice(firstBrace, lastBrace + 1);
      }
    }
  }

  return jsonText;
}

// ── Group by ─────────────────────────────────────────────────
// Groups an array of items by a key derived from each item.

export function groupBy<T>(items: T[], keyFn: (item: T) => string): Record<string, T[]> {
  const result: Record<string, T[]> = {};
  for (const item of items) {
    const key = keyFn(item);
    if (!result[key]) result[key] = [];
    result[key].push(item);
  }
  return result;
}
