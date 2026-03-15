// ============================================================
// NEXUS — FORGE Module
// Code evolution engine: NEXUS rewrites its own source files
//
// FORGE receives change requests from AXIOM, patches src/ files,
// validates with tsc, and reverts on failure. Protected files
// (security.ts, session.yml) can never be touched.
// ============================================================

import Anthropic from "@anthropic-ai/sdk";
import { execSync } from "child_process";
import * as fs   from "fs";
import * as path from "path";
import { getMaxOutputTokens } from "./security";
import { stripSurrogates } from "./utils";
import type { ForgeRequest, ForgeResult } from "./types";

const SRC_DIR = path.join(process.cwd(), "src");

// ── Dangerous code patterns FORGE must never write ────────
const DANGEROUS_CODE_PATTERNS: { pattern: RegExp; label: string; check?: (code: string) => boolean }[] = [
  {
    pattern: /process\.env\.\w+/,
    label:   "secret exfiltration (process.env combined with fetch)",
    check:   (code) => /process\.env\.\w+/.test(code) && /\bfetch\s*\(/.test(code),
  },
  { pattern: /child_process/,                     label: "child_process import" },
  { pattern: /\bexecSync\s*\(/,                   label: "execSync call" },
  { pattern: /\bexec\s*\(/,                       label: "exec call" },
  { pattern: /\bfs\s*\.\s*writeFileSync\s*\(/,    label: "fs.writeFileSync call" },
  { pattern: /\bfs\s*\.\s*unlinkSync\s*\(/,       label: "fs.unlinkSync call" },
  { pattern: /\bfs\s*\.\s*rmSync\s*\(/,           label: "fs.rmSync call" },
  { pattern: /\bfs\s*\.\s*renameSync\s*\(/,       label: "fs.renameSync call" },
  { pattern: /\beval\s*\(/,                        label: "eval call" },
];

// ── Content safety scan for AI-generated code ─────────────

export function isCodeSafe(code: string): { safe: boolean; reason?: string } {
  for (const entry of DANGEROUS_CODE_PATTERNS) {
    if (entry.check) {
      if (entry.check(code)) {
        return { safe: false, reason: `FORGE output blocked — dangerous pattern: ${entry.label}` };
      }
    } else {
      if (entry.pattern.test(code)) {
        return { safe: false, reason: `FORGE output blocked — dangerous pattern: ${entry.label}` };
      }
    }
  }
  return { safe: true };
}

// ── Files FORGE can never modify ──────────────────────────
// security.ts  — constitutional, must not self-modify
// session.yml  — self-modifying execution environment is too dangerous
const PROTECTED_FILES = new Set([
  "security.ts",
  "forge.ts",      // FORGE cannot rewrite itself
  "session.yml",   // self-modifying execution environment is too dangerous
  "README.md",     // documentation integrity — FORGE must not strip formatting
]);

// ── Filename prefixes FORGE can never modify ─────────────
const PROTECTED_PREFIXES = ["security", "forge"];

// ── Max file size FORGE will attempt to patch ─────────────
const MAX_FILE_CHARS = 12000;

// ── Max code changes per session ──────────────────────────
const MAX_FORGE_REQUESTS_PER_SESSION = 2;

// ── Run FORGE ─────────────────────────────────────────────

export async function runForge(
  client:   Anthropic,
  requests: ForgeRequest[],
  sessionNumber: number
): Promise<ForgeResult[]> {
  const results: ForgeResult[] = [];

  if (requests.length === 0) return results;

  const capped = requests.slice(0, MAX_FORGE_REQUESTS_PER_SESSION);
  if (requests.length > MAX_FORGE_REQUESTS_PER_SESSION) {
    console.log(`  ⚠ FORGE: capped at ${MAX_FORGE_REQUESTS_PER_SESSION} changes per session (was ${requests.length})`);
  }

  for (const req of capped) {
    console.log(`  ⚒  FORGE: patching ${req.file} — ${req.description}`);
    const result = await applyForgeRequest(client, req, sessionNumber);
    results.push(result);

    if (result.success) {
      console.log(`  ✔ FORGE: ${req.file} patched (${result.linesChanged ?? "?"} lines changed)`);
    } else {
      console.log(`  ✖ FORGE: ${req.file} failed — ${result.reason}${result.reverted ? " (reverted)" : ""}`);
    }
  }

  return results;
}

// ── Apply a single change request ─────────────────────────

async function applyForgeRequest(
  client:        Anthropic,
  req:           ForgeRequest,
  sessionNumber: number
): Promise<ForgeResult> {
  const filename = path.basename(req.file);

  // ── Security: block protected files ──
  if (PROTECTED_FILES.has(filename)) {
    return {
      file:     req.file,
      success:  false,
      reason:   `${filename} is protected — FORGE cannot modify it`,
      reverted: false,
    };
  }

  // ── Security: block files matching protected prefixes ──
  const lowerFilename = filename.toLowerCase();
  for (const prefix of PROTECTED_PREFIXES) {
    if (lowerFilename.startsWith(prefix)) {
      return {
        file:     req.file,
        success:  false,
        reason:   `${filename} matches protected prefix "${prefix}" — FORGE cannot modify it`,
        reverted: false,
      };
    }
  }

  // ── Only allow src/*.ts files or README.md — block everything else ──
  const isSourceFile = req.file.endsWith(".ts") && !req.file.includes("/") && !req.file.includes("\\") && !req.file.includes("..");
  const isReadme     = filename === "README.md";

  if (!isSourceFile && !isReadme) {
    return {
      file:     req.file,
      success:  false,
      reason:   `FORGE only patches .ts files inside src/ or README.md — no other paths`,
      reverted: false,
    };
  }

  const filePath = isReadme
    ? path.join(process.cwd(), "README.md")
    : path.join(SRC_DIR, filename);

  if (!fs.existsSync(filePath)) {
    return {
      file:     req.file,
      success:  false,
      reason:   `File not found: ${filePath}`,
      reverted: false,
    };
  }

  const originalContent = fs.readFileSync(filePath, "utf-8");

  if (originalContent.length > MAX_FILE_CHARS) {
    return {
      file:     req.file,
      success:  false,
      reason:   `File too large for FORGE (${originalContent.length} chars, max ${MAX_FILE_CHARS})`,
      reverted: false,
    };
  }

  // ── Ask Claude to patch the file ──
  const systemMessage = `You are NEXUS FORGE, the code evolution engine of the NEXUS market intelligence system.
You receive a TypeScript source file and a precise description of a change to make.
You return the COMPLETE modified file — the entire file content, nothing else.
No explanations, no markdown, no code fences. Just the raw TypeScript.
You write clean, minimal changes. You do not refactor or rename anything not related to the requested change.
You preserve all existing comments, interfaces, and exports.`;

  const userMessage = `## File: src/${filename}
## Session: #${sessionNumber}
## Change requested: ${req.description}
## Reason: ${req.reason}

## Current file content:
${originalContent}

Return the complete modified file with the requested change applied.`;

  let patchedContent: string;

  try {
    const response = await client.messages.create({
      model:      "claude-sonnet-4-20250514",
      max_tokens: getMaxOutputTokens(),
      system:     stripSurrogates(systemMessage),
      messages:   [{ role: "user", content: stripSurrogates(userMessage) }],
    });

    patchedContent = response.content
      .filter((b) => b.type === "text")
      .map((b) => (b as { type: "text"; text: string }).text)
      .join("")
      .replace(/^```typescript\n?|^```ts\n?|^```\n?|```\n?$/gm, "")
      .trim();

    if (!patchedContent) throw new Error("FORGE returned empty content");

  } catch (err) {
    return {
      file:     req.file,
      success:  false,
      reason:   `API error: ${err}`,
      reverted: false,
    };
  }

  // ── Content safety scan ──
  const safetyCheck = isCodeSafe(patchedContent);
  if (!safetyCheck.safe) {
    return {
      file:     req.file,
      success:  false,
      reason:   safetyCheck.reason ?? "FORGE output blocked — dangerous pattern detected",
      reverted: false,
    };
  }

  // ── Write the patched file ──
  fs.writeFileSync(filePath, patchedContent + "\n", "utf-8");

  // ── Validate with tsc ──
  const compileOk = validateTypeScript();

  if (!compileOk) {
    // Revert
    fs.writeFileSync(filePath, originalContent, "utf-8");
    return {
      file:     req.file,
      success:  false,
      reason:   "TypeScript compile failed — reverted to original",
      reverted: true,
    };
  }

  // ── Count lines changed (actual diff, not just line count delta) ──
  const originalLinesList = originalContent.split("\n");
  const patchedLinesList  = patchedContent.split("\n");
  const originalSet = new Set(originalLinesList);
  let changedLines = 0;
  for (const line of patchedLinesList) {
    if (!originalSet.has(line)) changedLines++;
  }
  const patchedSet = new Set(patchedLinesList);
  for (const line of originalLinesList) {
    if (!patchedSet.has(line)) changedLines++;
  }
  const linesChanged = changedLines;

  return {
    file:         req.file,
    success:      true,
    reason:       "Patch applied and validated",
    reverted:     false,
    linesChanged,
  };
}

// ── TypeScript validation ──────────────────────────────────

function validateTypeScript(): boolean {
  try {
    execSync("npx tsc --noEmit", {
      cwd:    process.cwd(),
      stdio:  "pipe",
      timeout: 30000,
    });
    return true;
  } catch {
    return false;
  }
}

// ── Format FORGE results for journal ──────────────────────

export function formatForgeResults(results: ForgeResult[]): string {
  if (results.length === 0) return "";

  const lines = ["### FORGE Code Changes"];
  for (const r of results) {
    const icon = r.success ? "✔" : r.reverted ? "↩" : "✖";
    lines.push(`${icon} \`${r.file}\` — ${r.reason}`);
  }
  return lines.join("\n");
}

export { MAX_FORGE_REQUESTS_PER_SESSION, PROTECTED_FILES, PROTECTED_PREFIXES };