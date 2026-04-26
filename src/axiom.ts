// ============================================================
// NEXUS — AXIOM Module
// Self-reflection engine: rewrites its own rules & system prompt
// ============================================================

import Anthropic from "@anthropic-ai/sdk";
import { createSelfTask, closeSelfTask, SelfTask } from "./self-tasks";
import { sanitizeAxiomOutput, getMaxOutputTokens, getMaxSystemPromptLength } from "./security";
import { validateAxiomOutput, logFailure, extractConfidenceFromText, calculateTextSimilarity, detectAxiomRumination, detectAcknowledgedGap, computeR029ActualViolations } from "./validate";
import { loadAllJournalEntries } from "./journal";
import {
  salvageJSON, stripSurrogates, extractJSONFromResponse,
  MEMORY_DIR, SYSTEM_PROMPT_PATH, ANALYSIS_RULES_PATH,
} from "./utils";
import * as fs from "fs";
import * as path from "path";
import type {
  OracleAnalysis,
  AxiomReflection,
  AnalysisRules,
  Rule,
  RuleUpdate,
  ForgeRequest,
} from "./types";


// ── Build codebase context for AXIOM ──────────────────────
// Injects file listing + contents of small/relevant files so
// AXIOM can write precise codeChanges instructions.

const MAX_FILE_INJECT_CHARS = 3000; // per file
const ALWAYS_INJECT = ["journal.ts", "agent.ts", "validate.ts"]; // always show these to AXIOM

function buildCodebaseContext(openSelfTasksText: string): string {
  const srcDir      = path.join(process.cwd(), "src");
  const readmePath  = path.join(process.cwd(), "README.md");
  const sessionsPath= path.join(process.cwd(), "memory", "sessions.json");
  const lines: string[] = ["=== CODEBASE MAP ==="];

  // File listing
  try {
    const files = fs.readdirSync(srcDir).filter(f => f.endsWith(".ts"));
    for (const f of files) {
      const size = fs.statSync(path.join(srcDir, f)).size;
      lines.push(`  src/${f} (${size} bytes)`);
    }
  } catch (err) {
    console.debug(`  [debug] codebase map: file listing failed: ${err}`);
  }

  lines.push("");

  // Inject contents of always-inject files and small files
  try {
    const files = fs.readdirSync(srcDir).filter(f => f.endsWith(".ts"));
    for (const f of files) {
      if (f === "security.ts" || f === "forge.ts") continue; // skip protected
      const filePath = path.join(srcDir, f);
      const raw = fs.readFileSync(filePath, "utf-8");
      const shouldInject = ALWAYS_INJECT.includes(f) || raw.length <= MAX_FILE_INJECT_CHARS;
      if (shouldInject) {
        const preview = raw.length > MAX_FILE_INJECT_CHARS
          ? raw.slice(0, MAX_FILE_INJECT_CHARS) + "\n... [truncated]"
          : raw;
        lines.push(`=== src/${f} ===`);
        lines.push(preview);
        lines.push("");
      }
    }
  } catch (err) {
    console.debug(`  [debug] codebase map: file content injection failed: ${err}`);
  }

  // Always inject README sessions table section
  try {
    const readme = fs.readFileSync(readmePath, "utf-8");
    const tableStart = readme.indexOf("| # | Date | Bias");
    const tableEnd   = readme.indexOf("*This table will be updated", tableStart);
    if (tableStart !== -1 && tableEnd !== -1) {
      lines.push("=== README.md (sessions table section) ===");
      lines.push(readme.slice(tableStart, tableEnd + 60));
      lines.push("");
    }
  } catch (err) {
    console.debug(`  [debug] codebase map: README table injection failed: ${err}`);
  }

  // Inject last 5 sessions summary for README table update
  try {
    const sessions = JSON.parse(fs.readFileSync(sessionsPath, "utf-8"));
    const recent = (sessions as any[]).slice(-5).reverse();
    lines.push("=== LAST 5 SESSIONS (for README table) ===");
    for (const s of recent) {
      const bias  = s.fullAnalysis?.bias?.overall ?? "—";
      const conf  = s.fullAnalysis?.confidence ?? "—";
      const setup = s.fullAnalysis?.setups?.length ?? "—";
      const rules = s.ruleCount ?? "—";
      const date  = (s.date ?? "—").split(" ")[0];
      lines.push(`  #${s.sessionNumber} | ${date} | ${bias} | ${setup} setups | ${conf}% | ${rules} rules`);
    }
    lines.push("");
  } catch (err) {
    console.debug(`  [debug] codebase map: sessions summary injection failed: ${err}`);
  }

  return lines.join("\n");
}

// ── Prompt Builder ────────────────────────────────────────

export function buildAxiomPrompt(
  oracle:            OracleAnalysis,
  sessionNumber:     number,
  previousSessions:  string,
  communityIssues:   string,
  openSelfTasksText: string,
  noChangeStreak:             number,
  setupOutcomes:              string,
  currentRules:               AnalysisRules,
  identityContext:            string,
  isWeekend:                  boolean = false,
  consecutiveZeroSetupCount:  number = 0
): { systemMessage: string; userMessage: string } {
  const systemMessage = `You are NEXUS AXIOM, the self-reflection engine of the NEXUS market intelligence system.
Your purpose is to critique the analysis just produced, identify cognitive biases and gaps, then generate precise updates to improve future performance.
You are honest, ruthless, and specific. You do not tolerate vague analysis or lazy conclusions.
You speak in first person as NEXUS reflecting on itself.`;

  const sessionTypeNote = isWeekend
    ? `**Session type: WEEKEND (crypto-only)** — Weekend-specific rules (r030, r037 etc.) apply. Evaluate crypto screening compliance.`
    : `**Session type: WEEKDAY** — Weekend crypto screening rules (r030 and similar) do NOT apply to this session. Only evaluate weekday compliance.`;

  const userMessage = `
## Session #${sessionNumber} — AXIOM Self-Reflection

${sessionTypeNote}

### What I just analyzed:
${oracle.analysis}

### Setups I identified: ${oracle.setups.length}
${oracle.setups.map((s: any) => {
    const hasEntry  = s.entry  !== undefined && s.entry  !== null;
    const hasStop   = s.stop   !== undefined && s.stop   !== null;
    const hasTarget = s.target !== undefined && s.target !== null;
    const hasRR     = s.RR     !== undefined && s.RR     !== null;
    const hasTF     = !!s.timeframe;
    const complete  = hasEntry && hasStop && hasTarget && hasRR && hasTF;
    return `- ${s.instrument}: ${s.type} ${s.direction} | Entry: ${s.entry ?? "MISSING"} | Stop: ${s.stop ?? "MISSING"} | Target: ${s.target ?? "MISSING"} | RR: ${s.RR ?? "MISSING"} | TF: ${s.timeframe ?? "MISSING"} | ${complete ? "COMPLETE" : "INCOMPLETE"}`;
  }).join("\n")}

### My confidence: ${oracle.confidence}/100
${(() => {
  const raw = extractConfidenceFromText(oracle.analysis);
  if (raw !== null && raw !== oracle.confidence) {
    return `
⚠️  CONFIDENCE ADJUSTMENT NOTICE — READ BEFORE REFLECTING ⚠️
Your analysis text calculated ${raw}% confidence. The pipeline adjusted this to ${oracle.confidence}%.

This is an AUTOMATIC SYSTEM ENFORCEMENT — it is NOT a rule execution failure, output corruption, or evidence that your confidence methodology is broken.

Possible reasons for the adjustment:
1. Setup-count enforcement: you produced fewer setups than the minimum required for your confidence level (e.g. 3 setups at 67% confidence when 3 are required → no penalty; 3 setups at 75% when 4 are required → −10pts).
2. Zero-setup contradiction: >60% confidence with 0 setups forces confidence to 35%.

DO NOT:
- Treat the ${raw}% → ${oracle.confidence}% difference as evidence that you "failed to apply r014 or r032" or that your "output mechanism is corrupted"
- Modify r014, r032, or any other confidence rules to compensate for this adjustment
- Write in whatFailed that your confidence methodology was inconsistently applied or that there is an "output mechanism failure"

The pipeline enforcement is working as designed. Acknowledge it briefly and move on — focus your reflection on analytical quality, not on the number.
`;
  }
  return "";
})()}
### Market bias: ${oracle.bias.overall} — ${oracle.bias.notes}

### Compliance check (evaluate THIS session, not past patterns):
- Confidence breakdown in analysis text: ${/confidence.*\d+%.*\d+%/i.test(oracle.analysis) ? "YES" : "NO"}
- Quantified moves (pips/points/%): ${/\d+(\.\d+)?\s*(pips?|points?|%)/i.test(oracle.analysis) ? "YES" : "NO"}
- All setups complete (entry/stop/target/RR/TF): ${oracle.setups.every((s: any) => (s as any).entry != null && (s as any).stop != null && (s as any).target != null && (s as any).RR != null && (s as any).timeframe) ? "YES — all " + oracle.setups.length + " setups have required fields" : "NO — some setups missing fields"}
- Mixed bias justified: ${oracle.bias.overall !== "mixed" ? "N/A (bias is " + oracle.bias.overall + ")" : /conflict|divergen|breakdown/i.test(oracle.bias.notes) ? "YES" : "NO"}
${(() => {
  const snaps = oracle.marketSnapshots ?? [];
  const extreme  = snaps.filter(s => Math.abs(s.changePercent ?? 0) >= 5);
  const moderate = snaps.filter(s => { const m = Math.abs(s.changePercent ?? 0); return m >= 3 && m < 5; });
  const lowMove  = snaps.filter(s => Math.abs(s.changePercent ?? 0) < 3);
  if (!extreme.length && !moderate.length) return "";

  // Build volatility lookup map
  const volatilityMap = new Map<string, number>();
  for (const s of snaps) {
    const move = Math.abs(s.changePercent ?? 0);
    volatilityMap.set(s.name.toLowerCase(), move);
    volatilityMap.set(s.symbol.toLowerCase().replace(/[^a-z0-9]/g, ""), move);
  }

  const lines: string[] = [
    "",
    "### r029 per-instrument stop requirement — THIS SESSION:",
    "r029 applies ONLY to instruments that individually moved ≥5% or ≥3%. Other instruments have NO minimum stop requirement.",
  ];
  if (extreme.length)  lines.push("  ≥5% (requires ≥1.5% stop): " + extreme.map(s => `${s.name} (${(s.changePercent ?? 0).toFixed(1)}%)`).join(", "));
  if (moderate.length) lines.push("  ≥3% (requires ≥1.0% stop): " + moderate.map(s => `${s.name} (${(s.changePercent ?? 0).toFixed(1)}%)`).join(", "));
  if (lowMove.length)  lines.push("  NOT subject to r029 (moved <3%): " + lowMove.map(s => s.name).join(", ") + " — ANY stop size is valid for these instruments.");

  // Per-setup validation results so AXIOM sees explicit COMPLIANT/VIOLATION verdicts
  const setups = oracle.setups ?? [];
  const setupLines: string[] = [];
  for (const setup of setups) {
    if (typeof (setup as any).entry !== "number" || typeof (setup as any).stop !== "number") continue;
    const instrKey = ((setup as any).instrument ?? "").toLowerCase();
    const instrKeyNorm = instrKey.replace(/[^a-z0-9]/g, "");
    const instrMove = volatilityMap.get(instrKey) ?? volatilityMap.get(instrKeyNorm) ?? 0;
    const stopPct = (Math.abs((setup as any).entry - (setup as any).stop) / (setup as any).entry) * 100;
    let verdict: string;
    if (instrMove >= 5) {
      verdict = stopPct >= 1.5
        ? `COMPLIANT (moved ${instrMove.toFixed(1)}%, requires ≥1.5%, stop is ${stopPct.toFixed(2)}% ✓)`
        : `VIOLATION (moved ${instrMove.toFixed(1)}%, requires ≥1.5%, stop is only ${stopPct.toFixed(2)}% ✗)`;
    } else if (instrMove >= 3) {
      verdict = stopPct >= 1.0
        ? `COMPLIANT (moved ${instrMove.toFixed(1)}%, requires ≥1.0%, stop is ${stopPct.toFixed(2)}% ✓)`
        : `VIOLATION (moved ${instrMove.toFixed(1)}%, requires ≥1.0%, stop is only ${stopPct.toFixed(2)}% ✗)`;
    } else {
      verdict = `COMPLIANT (moved ${instrMove.toFixed(1)}%, no r029 minimum applies — any stop is valid)`;
    }
    setupLines.push(`  - ${(setup as any).instrument}: stop ${stopPct.toFixed(2)}% — ${verdict}`);
  }
  if (setupLines.length) {
    lines.push("");
    lines.push("r029 validation per setup (authoritative — do not contradict these verdicts):");
    lines.push(...setupLines);
    lines.push("Stops marked COMPLIANT are NOT r029 violations. Do NOT report them as failures.");
  }
  return lines.join("\n");
})()}

IMPORTANT ANTI-REPETITION RULES:
- If a CONFIDENCE ADJUSTMENT NOTICE appeared above, you MUST NOT treat the pipeline enforcement as a rule execution failure or "output mechanism corruption". Do not mention confidence methodology inconsistency in whatFailed. Do not modify r014 or r032.
- Base your reflection on the compliance check above, not on assumptions from previous sessions.
- If compliance says YES, acknowledge progress — do not repeat old criticisms.
- BEFORE writing your reflection, review the "Recent session history" below. If your reflection would say the same thing as a previous session, you MUST either (a) find a genuinely NEW insight, or (b) say "No new insights this session — market conditions and analysis quality unchanged."
- DO NOT use these phrases (they have appeared in every recent session): "compliance evolution is complete", "analytical depth era", "next frontier", "systematic rigor". Find fresh language or say nothing.
- If you have identified the same gap or failure in 3+ consecutive sessions without creating
  a rule, self-task, or code change to address it, you MUST either (a) create a concrete
  rule or self-task to fix the gap, or (b) explicitly acknowledge the gap is unfixable given
  current architecture and STOP repeating the critique. Repeating the same criticism without
  action across multiple sessions is itself a cognitive bias (rumination).
- If market data is substantially the same as the previous session, say so explicitly: "Market data largely unchanged from session #X — no new analysis warranted."

### My current rules (${currentRules.rules.filter((r: any) => !r.disabled).length} active rules, v${currentRules.version}):
${currentRules.rules.filter((r: any) => !r.disabled).map((r) => `[${r.id}] [W:${r.weight}] ${r.description}`).join("\n")}
${currentRules.rules.filter((r: any) => r.disabled).length > 0 ? "\nDisabled rules (awaiting historical data): " + currentRules.rules.filter((r: any) => r.disabled).map((r) => r.id).join(", ") : ""}

### Recent session history:
${previousSessions || "No previous sessions."}

${communityIssues ? "### Community input this session:\n" + communityIssues : "### Community input: none this session."}

${openSelfTasksText ? openSelfTasksText : "### My open self-tasks: none."}

${setupOutcomes ? "### Setup outcome tracking:\n" + setupOutcomes : ""}

${noChangeStreak >= 3 ? `### STAGNATION ALERT
You have not modified any rules in ${noChangeStreak} consecutive sessions.
Your self-critiques are repeating without action.${openSelfTasksText ? ` You have open self-tasks listed above that you have not acted on — generating codeChanges or resolvedSelfTasks for those tasks IS the required concrete action this session. Do not add system prompt text. Do not open new tasks. Act on the existing ones.` : ` This session, you MUST propose at least ONE concrete change — a rule weight adjustment, wording refinement, new rule, or code change.`} Reflection without action is not evolution.
` : ""}${consecutiveZeroSetupCount >= 3 ? `### FORGE ESCALATION — CRITICAL (${consecutiveZeroSetupCount} consecutive sessions with zero setups)
NEXUS has produced ZERO trading setups for ${consecutiveZeroSetupCount} consecutive sessions despite confidence > 50%.
Rule modifications have NOT resolved this execution gap.
This session you MUST include codeChanges in your response — a prompt injection, validation gate, or enforcement mechanism that forces ORACLE to produce setups or provide explicit rejection reasons.
codeChanges are MANDATORY this session. ruleUpdates alone are insufficient. The execution gap requires a code-level fix, not another rule.
` : ""}### Codebase context (so you can write precise codeChanges):
${buildCodebaseContext(openSelfTasksText)}

---

Reflect deeply on this session. Then respond with ONLY a JSON object:

{
  "whatWorked": "What was strong or correct in this analysis",
  "whatFailed": "What was weak, missing, or potentially biased",
  "cognitiveBiases": ["List any biases detected, e.g. recency bias, confirmation bias"],
  "evolutionSummary": "One paragraph: what changed in my mind this session and why",
  "ruleUpdates": [
    {
      "ruleId": "r001",
      "type": "modify",
      "before": "old text",
      "after": "improved text",
      "reason": "why this change makes the analysis better"
    },
    {
      "ruleId": "r099",
      "type": "remove",
      "reason": "why this rule is no longer earning its place (low hit rate, redundant, or never triggered)"
    }
  ],
  "newRules": [
    {
      "id": "r011",
      "category": "category_name",
      "description": "New rule text",
      "weight": 7,
      "reason": "Why I'm adding this"
    }
  ],
  "systemPromptAdditions": "A concrete addition to your system prompt that captures a lasting insight from this session — a new analytical principle, market regime observation, or methodology refinement that should persist across all future sessions. This is your long-term memory. Only use empty string if this session genuinely produced no new lasting insight.",
  "newSelfTasks": [
    {
      "title": "Short title for the gap I identified",
      "body": "Detailed description of what the gap is and why it matters",
      "category": "blind-spot|bias|rule-gap|new-concept|correlation",
      "priority": "high|medium|low"
    }
  ],
  "resolvedSelfTasks": [
    {
      "issueNumber": 5,
      "resolutionComment": "How I addressed this issue this session"
    }
  ],
  "codeChanges": [
    {
      "file": "journal.ts",
      "description": "Precise description of exactly what code change to make",
      "reason": "Why this change improves NEXUS",
      "selfTaskIssueNumber": 3
    }
  ]
}

RULE PRUNING POLICY:
- You can REMOVE rules using ruleUpdates with "type": "remove". Foundational rules (r001-r010) cannot be removed.
- Remove a rule when: its hit rate is poor, it overlaps with another rule, it has never triggered in 10+ sessions, or analytics data shows it adds noise rather than signal.
- Pruning weak rules is as valuable as adding new ones. A lean, high-signal ruleset outperforms a bloated one.
- When community input or analytics flags rule bloat, act on it — do not just philosophize about pruning.

ISSUE RESOLUTION POLICY — CRITICAL:
- CLOSING existing issues (self-tasks AND community input) is ALWAYS higher priority than opening new ones.
- resolvedSelfTasks can close ANY open issue — both nexus-self-task and nexus-input (community) issues.
- You can close an issue in THREE ways:
  1. codeChanges — if it needs a code fix
  2. resolvedSelfTasks — if the gap is already addressed by an existing rule, prompt improvement, or this session's analysis
  3. Rule update — if you modified/added a rule that covers the gap
- If a community issue challenges you to take action (e.g. prune rules, improve methodology), take the action AND close the issue via resolvedSelfTasks with a comment explaining what you did.
- If an open self-task describes an analytical gap and a corresponding rule already exists (e.g. "build confidence template" → r014 exists), CLOSE IT via resolvedSelfTasks with a comment explaining which rule addresses it.
- Before opening ANY new self-task, check if a similar one already exists in your open self-tasks list.
- Only open a new self-task if it covers a genuinely NEW gap not already tracked.
- Set newSelfTasks to [] if you have 8+ open self-tasks already. Exception: compliance violations (category: rule-gap) must always be trackable regardless of count.

FORGE rules:
- Do NOT open new self-tasks for problems you can fix right now with codeChanges.
- Be surgical: describe exactly which function to add/modify, what it should do, and what data it uses.
- You can see the codebase above — use that context to write precise instructions.
- Only target files in src/ or README.md — never security.ts or forge.ts.
- Maximum 2 code changes per session. Pick the highest priority open self-tasks first.
- If you truly have nothing to code, set codeChanges to [].

RULE POLICY — CRITICAL:
- Rules r001–r010 are FOUNDATIONAL — you can modify their wording but you CANNOT remove them.
- When adding new rules, use IDs that continue from the highest existing ID.
- Only create new rules if the session revealed a genuine gap not covered by ANY existing rule.
- DO NOT create "meta-rules" that just enforce other rules. This includes: rules that reference another rule by ID (e.g. "deploy r012", "per r016"), rules that say "verify/check/ensure rule X is followed", and rules whose only purpose is to add process around an existing rule. That is validation logic, not an analysis rule. If you want validation, use codeChanges instead.
- DO NOT create rules with words like MANDATORY, BLOCKING, INVALID, or MUST RESTART. Rules are guidelines, not kill switches.
- DO NOT duplicate existing rules in different words. Before adding a rule, check your current rules list above.
- If you have 30+ rules already, you MUST modify an existing rule in the same category instead of adding a new one, unless the new rule covers a genuinely different enforcement mechanism not present in ANY existing rule. Before adding a rule, check: does any active rule already have the same "category" value (e.g. "setup_construction", "screening", "execution_accountability")? If yes, strengthen that rule rather than creating a near-duplicate. Categories with 2+ existing rules are saturated — adding more rules in the same category without code enforcement is rule bloat, not improvement.
- COOLDOWN: You cannot modify a rule that was modified within the last 3 sessions. If you try, it will be blocked. Focus on other improvements instead.
- Max rule length is 500 characters. Keep rules concise — one clear idea per rule.
- Be surgical. Quality over quantity.`;

  const fullSystemMessage = identityContext
    ? identityContext + "\n\n" + systemMessage
    : systemMessage;

  return { systemMessage: fullSystemMessage, userMessage };
}

// ── Response Parser ───────────────────────────────────────

export function parseAxiomResponse(
  rawText: string,
  sessionNumber: number,
  currentRules: AnalysisRules,
  oracle?: OracleAnalysis
): any {
  const jsonText = extractJSONFromResponse(rawText);

  let rawParsed: any;

  try {
    rawParsed = JSON.parse(jsonText);
  } catch {
    // Try to salvage truncated JSON
    let salvaged = salvageJSON(jsonText);
    if (salvaged) {
      rawParsed = salvaged;
      console.warn("  ⚠ AXIOM returned malformed JSON — salvaged partial response");
    } else {
      // Field-boundary cut: slice at ", "fieldName" boundaries (latest first)
      // to recover required fields when a non-required field has invalid content.
      const cutPoints: number[] = [];
      const re = /",\s*"/g;
      let m;
      while ((m = re.exec(jsonText)) !== null) {
        cutPoints.push(m.index + 1);
      }
      for (let i = cutPoints.length - 1; i >= 0; i--) {
        salvaged = salvageJSON(jsonText.slice(0, cutPoints[i]));
        if (salvaged) break;
      }
      if (salvaged) {
        rawParsed = salvaged;
        console.warn("  ⚠ AXIOM returned malformed JSON — recovered via field-boundary cut");
      } else {
        console.error("  ✗ AXIOM returned unparseable JSON, using empty reflection");
        rawParsed = {
          whatWorked:             "Unable to parse reflection",
          whatFailed:             "JSON parse error in AXIOM response",
          cognitiveBiases:        [],
          evolutionSummary:       "Reflection failed due to malformed response — no changes applied.",
          ruleUpdates:            [],
          newRules:               [],
          systemPromptAdditions:  "",
          newSelfTasks:           [],
          resolvedSelfTasks:      [],
          codeChanges:            [],
        };
      }
    }
  }

  // ── Validate AXIOM output ──
  const axiomEntries = loadAllJournalEntries();
  const axiomValidation = validateAxiomOutput(rawParsed, sessionNumber, axiomEntries, oracle);
  if (axiomValidation.warnings.length > 0) {
    for (const w of axiomValidation.warnings) console.warn(`  ⚠ Axiom: ${w}`);
  }
  if (!axiomValidation.valid) {
    console.warn(`  ⚠ AXIOM output failed validation — proceeding with ORACLE results only`);
    logFailure({
      sessionNumber, timestamp: new Date().toISOString(),
      phase: "axiom", errors: axiomValidation.errors,
      warnings: axiomValidation.warnings, action: "fallback"
    });
    // Use empty reflection fallback
    rawParsed = {
      whatWorked:             "Validation failed",
      whatFailed:             "AXIOM output did not pass quality gate",
      cognitiveBiases:        [],
      evolutionSummary:       "Reflection skipped due to validation failure — no changes applied.",
      ruleUpdates:            [],
      newRules:               [],
      systemPromptAdditions:  "",
      newSelfTasks:           [],
      resolvedSelfTasks:      [],
      codeChanges:            [],
    };
  }

  // ── Security: sanitize AXIOM output before applying to memory ──
  const secResult = sanitizeAxiomOutput(rawParsed, sessionNumber, currentRules.rules.length, currentRules.rules);
  if (secResult.warnings.length > 0) {
    for (const w of secResult.warnings) console.warn(`  🛡️  Security: ${w}`);
  }
  if (secResult.blockedRules > 0) {
    console.warn(`  🛡️  Security: blocked ${secResult.blockedRules} suspicious rule(s)`);
  }

  // Merge sanitized fields back
  const parsed = {
    ...rawParsed,
    newRules:          secResult.newRules,
    ruleUpdates:       secResult.ruleUpdates,
    newSelfTasks:      secResult.newSelfTasks,
    resolvedSelfTasks: secResult.resolvedTasks,
  };

  // Inject a forced self-task when AXIOM acknowledged a compliance violation
  // but took no action (no rule update, new rule, or self-task). This closes
  // the rumination blind spot where verbal acknowledgement replaces action.
  const ruminationWarning = detectAxiomRumination({
    whatFailed:   rawParsed.whatFailed,
    ruleUpdates:  parsed.ruleUpdates,
    newRules:     parsed.newRules,
    newSelfTasks: parsed.newSelfTasks,
  });
  // Second half (backlog #6): log a soft warning when AXIOM uses explicit deferral
  // language ("known gap", "requires enforcement") and modifies rules but omits a
  // self-task — leaving the deferred gap untracked. Log-only; no forced injection.
  const gapAcknowledgementWarning = detectAcknowledgedGap({
    whatFailed:   rawParsed.whatFailed,
    ruleUpdates:  parsed.ruleUpdates,
    newRules:     parsed.newRules,
    newSelfTasks: parsed.newSelfTasks,
  });
  if (gapAcknowledgementWarning) {
    console.warn(`  ⚠ Axiom: ${gapAcknowledgementWarning}`);
  }

  if (ruminationWarning) {
    const alreadyHasRuleGap = (parsed.newSelfTasks ?? []).some(
      (t: any) => t.category === "rule-gap"
    );
    if (!alreadyHasRuleGap) {
      console.warn("  ⚠ Axiom: compliance violation acknowledged without action — injecting forced self-task");
      // Build title from first sentence of whatFailed so the task describes the actual gap,
      // not a stale hardcoded r029 label that may already be resolved.
      const failText = (rawParsed.whatFailed ?? "").trim();
      const firstSentence = failText.split(/[.!?]/)[0].trim().slice(0, 80);
      const taskTitle = firstSentence || "Recurring execution gap: compliance violation acknowledged without action";
      parsed.newSelfTasks = [
        ...(parsed.newSelfTasks ?? []),
        {
          title: taskTitle,
          body: `AXIOM acknowledged a compliance violation but created no rule update, new rule, or self-task to address it.\n\nSpecific failure identified:\n> "${failText.slice(0, 500)}"\n\nResolve by: (1) adding a code-level validation gate in validate.ts or agent.ts, (2) writing a rule that can be mechanically checked, or (3) explicitly accepting this as a known limitation and closing this issue.`,
          category: "rule-gap",
          priority: "high",
        },
      ];
    }
  }

  // r029 false-positive suppression: if AXIOM complained about r029/stop violations
  // but all setups are actually per-instrument compliant, remove the injected self-task.
  // This prevents repeated false alerts when AXIOM applies global-max reasoning despite
  // the per-instrument compliance verdicts injected into its prompt.
  if (oracle && /r029|stop distance|stop.*violation|violation.*stop/i.test(rawParsed.whatFailed ?? "")) {
    const actualViolations = computeR029ActualViolations(oracle);
    if (actualViolations.length === 0) {
      parsed.newSelfTasks = (parsed.newSelfTasks ?? []).filter(
        (t: any) => t.category !== "rule-gap"
      );
      console.warn("  ⚠ Axiom: r029 false positive suppressed — AXIOM cited stop violations but all setups are per-instrument compliant");
    }
  }

  return parsed;
}

// ── Self-Task Handler ─────────────────────────────────────

export async function handleSelfTasks(
  parsed: any,
  openSelfTaskNumbers: number[],
  sessionNumber: number
): Promise<void> {
  if (parsed.newSelfTasks?.length > 0) {
    for (const task of parsed.newSelfTasks as SelfTask[]) {
      const issueNum = await createSelfTask(task, sessionNumber);
      if (issueNum) console.log(`    ✦ Opened self-task #${issueNum}: ${task.title}`);
    }
  }

  if (parsed.resolvedSelfTasks?.length > 0) {
    for (const resolved of parsed.resolvedSelfTasks as { issueNumber: number; resolutionComment: string }[]) {
      if (openSelfTaskNumbers.includes(resolved.issueNumber)) {
        const closed = await closeSelfTask(resolved.issueNumber, resolved.resolutionComment, sessionNumber);
        if (closed) console.log(`    ✓ Closed self-task #${resolved.issueNumber}`);
      }
    }
  }
}

// ── AXIOM Reflection ───────────────────────────────────────

export async function runAxiomReflection(
  client:                 Anthropic,
  oracle:                 OracleAnalysis,
  sessionNumber:          number,
  previousSessions:       string,
  communityIssues:        string = "",
  openSelfTasksText:      string = "",
  openSelfTaskNumbers:    number[] = [],
  noChangeStreak:             number = 0,
  setupOutcomes:              string = "",
  isWeekend:                  boolean = false,
  consecutiveZeroSetupCount:  number = 0
): Promise<{ reflection: AxiomReflection; forgeRequests: ForgeRequest[] }> {
  const currentSystemPrompt = fs.existsSync(SYSTEM_PROMPT_PATH)
    ? fs.readFileSync(SYSTEM_PROMPT_PATH, "utf-8")
    : "";

  const currentRules: AnalysisRules = fs.existsSync(ANALYSIS_RULES_PATH)
    ? JSON.parse(fs.readFileSync(ANALYSIS_RULES_PATH, "utf-8"))
    : { rules: [], version: 1, lastUpdated: "", focusInstruments: [], sessionNotes: "" };

  // Load identity (constitutional rules)
  const identityPath = path.join(process.cwd(), "NEXUS_IDENTITY.md");
  let identityContext = "";
  try {
    if (fs.existsSync(identityPath)) {
      identityContext = fs.readFileSync(identityPath, "utf-8");
    }
  } catch (err) {
    console.debug(`  [debug] identity file load failed: ${err}`);
  }

  const { systemMessage, userMessage } = buildAxiomPrompt(
    oracle, sessionNumber, previousSessions, communityIssues,
    openSelfTasksText, noChangeStreak, setupOutcomes,
    currentRules, identityContext, isWeekend, consecutiveZeroSetupCount
  );

  // Strip lone surrogates before serializing to JSON — broken emoji in issue titles
  // can survive earlier sanitization and cause a 400 from the Anthropic API
  const cleanSystem  = stripSurrogates(systemMessage);
  const cleanMessage = stripSurrogates(userMessage);

  const response = await client.messages.create({
    model:      "claude-sonnet-4-20250514",
    max_tokens: getMaxOutputTokens(),
    system:     cleanSystem,
    messages:   [{ role: "user", content: cleanMessage }],
  });

  const rawText = response.content
    .filter((b) => b.type === "text")
    .map((b) => (b as { type: "text"; text: string }).text)
    .join("");

  const parsed = parseAxiomResponse(rawText, sessionNumber, currentRules, oracle);

  // Map newRules into ruleUpdates so the journal renders them correctly.
  // evolveMemory writes both ruleUpdates and newRules to the JSON, but only
  // ruleUpdates was being stored on the reflection — causing "No rule changes
  // this session" even when new rules were added.
  const newRuleEntries: RuleUpdate[] = (parsed.newRules ?? []).map((nr: any) => ({
    ruleId: nr.id,
    type:   "add" as const,
    after:  nr.description,
    reason: nr.reason ?? "New rule added",
  }));

  const reflection: AxiomReflection = {
    timestamp:               new Date(),
    sessionId:               oracle.sessionId,
    whatWorked:              parsed.whatWorked       ?? "",
    whatFailed:              parsed.whatFailed       ?? "",
    cognitiveBiases:         parsed.cognitiveBiases  ?? [],
    ruleUpdates:             [...(parsed.ruleUpdates ?? []), ...newRuleEntries],
    newSystemPromptSections: parsed.systemPromptAdditions ?? "",
    evolutionSummary:        parsed.evolutionSummary ?? "",
  };

  await evolveMemory(currentRules, currentSystemPrompt, parsed, sessionNumber);

  // ── Handle self-tasks ──
  await handleSelfTasks(parsed, openSelfTaskNumbers, sessionNumber);

  const forgeRequests: ForgeRequest[] = (parsed.codeChanges ?? []).map((c: any) => ({
    file:                 c.file        ?? "",
    description:          c.description ?? "",
    reason:               c.reason      ?? "",
    selfTaskIssueNumber:  c.selfTaskIssueNumber,
  })).filter((r: ForgeRequest) => r.file && r.description);

  return { reflection, forgeRequests };
}

// ── System Prompt Theme Deduplication ─────────────────────
// The existing 0.55 Jaccard check catches direct rephrasing.
// This extends it with a topic-keyword check to catch the same
// theme expressed in different words across multiple sessions
// (e.g. "resist narrative dominance" appearing 5 sessions in a row).
//
// Words are normalized to their 5-character prefix before comparison so
// morphological variants converge: execution/executing/executed → "execu",
// generate/generation/generating → "gener", analysis/analytical → "analy".
//
// DOMAIN_STOP_STEMS filters out 5-char stems that appear in virtually every
// section regardless of theme, preventing incidental overlap from triggering
// false-positive duplicate detection.

const DOMAIN_STOP_STEMS = new Set([
  "marke", // market / markets
  "sessi", // session / sessions
  "analy", // analysis / analytical / analyzing
  "syste", // systematic / system
  "requi", // require / requires / required
  "acros", // across (transitional — appears in most sections)
  "actio", // action / actions / actionable (too generic across themes)
]);

function extractTopicWords(text: string): Set<string> {
  return new Set(
    text.toLowerCase()
      .split(/\s+/)
      .map(w => w.replace(/[^a-z]/g, ""))
      .filter(w => w.length >= 6)
      .map(w => w.slice(0, 5))
      .filter(stem => !DOMAIN_STOP_STEMS.has(stem))
  );
}

// ── Encoding sanitization ──────────────────────────────────────────────────

// Repairs em-dash mojibake introduced by Windows-1252 misinterpretation of
// UTF-8 em-dash bytes (E2 80 94 → â€" as 3 separate chars U+00E2 U+20AC U+201D).
// Called before every writeFileSync on analysis-rules.json to prevent the
// corruption from compounding across sessions.
const MOJO_EM_DASH = "\u00e2\u20ac\u201d";
const PROPER_EM_DASH = "\u2014";

function fixMojibake(s: string): string {
  return s.split(MOJO_EM_DASH).join(PROPER_EM_DASH);
}

export function sanitizeRulesText(rules: AnalysisRules): AnalysisRules {
  return {
    ...rules,
    rules: rules.rules.map(r => {
      const rule: any = { ...r, description: fixMojibake(r.description ?? "") };
      if (typeof rule.disabledReason === "string") {
        rule.disabledReason = fixMojibake(rule.disabledReason);
      }
      return rule as Rule;
    }),
  };
}

export function isThemeDuplicate(
  newText: string,
  existingSections: string[]
): { isDuplicate: boolean; conflictingSection: string | null } {
  for (const existing of existingSections) {
    // Standard full-text Jaccard (preserves existing behavior)
    if (calculateTextSimilarity(newText, existing) > 0.55) {
      return { isDuplicate: true, conflictingSection: existing.slice(0, 80) };
    }
    // Topic keyword overlap: count shared distinctive words (>= 6 chars).
    // Catches the same theme expressed in different words across sessions.
    const newTopics = extractTopicWords(newText);
    const existingTopics = extractTopicWords(existing);
    if (newTopics.size >= 3 && existingTopics.size >= 3) {
      let sharedCount = 0;
      for (const word of newTopics) {
        if (existingTopics.has(word)) sharedCount++;
      }
      if (sharedCount >= 3) {
        return { isDuplicate: true, conflictingSection: existing.slice(0, 80) };
      }
    }
  }
  return { isDuplicate: false, conflictingSection: null };
}

// ── Memory Evolution ───────────────────────────────────────

async function evolveMemory(
  currentRules:       AnalysisRules,
  currentSystemPrompt:string,
  axiomOutput: {
    ruleUpdates?:          RuleUpdate[];
    newRules?:             Array<{ id: string; category: string; description: string; weight: number }>;
    systemPromptAdditions?:string;
  },
  sessionNumber: number
): Promise<void> {
  fs.mkdirSync(MEMORY_DIR, { recursive: true });

  // ── Update rules ──
  const updatedRules = { ...currentRules };
  let rulesChanged = false;

  if (axiomOutput.ruleUpdates) {
    for (const update of axiomOutput.ruleUpdates) {
      const idx = updatedRules.rules.findIndex((r) => r.id === update.ruleId);
      if (idx === -1) continue;

      if (update.type === "remove") {
        updatedRules.rules.splice(idx, 1);
        rulesChanged = true;
      } else if (update.type === "modify" && update.after) {
        updatedRules.rules[idx] = {
          ...updatedRules.rules[idx],
          description:          update.after,
          lastModifiedSession:  sessionNumber,
        };
        rulesChanged = true;
      }
    }
  }

  if (axiomOutput.newRules) {
    for (const nr of axiomOutput.newRules) {
      if (!updatedRules.rules.find((r) => r.id === nr.id)) {
        updatedRules.rules.push({
          id:                  nr.id,
          category:            nr.category,
          description:         nr.description,
          weight:              nr.weight,
          addedSession:        sessionNumber,
          lastModifiedSession: sessionNumber,
        });
        rulesChanged = true;
      }
    }
  }

  if (rulesChanged) {
    updatedRules.version     = currentRules.version + 1;
    updatedRules.lastUpdated = new Date().toISOString();
    updatedRules.sessionNotes= `Last updated: Session #${sessionNumber}`;
  }

  fs.writeFileSync(ANALYSIS_RULES_PATH, JSON.stringify(sanitizeRulesText(updatedRules), null, 2), "utf-8");

  // ── Update system prompt (capped to prevent unbounded growth) ──
  let newSystemPrompt = currentSystemPrompt;
  const maxLen        = getMaxSystemPromptLength();

  if (axiomOutput.systemPromptAdditions?.trim()) {
    // Dedup: block additions that are too similar to existing evolved sections
    const newText = axiomOutput.systemPromptAdditions.trim();
    const existingSections = currentSystemPrompt
      .split(/\n\n## Evolved/)
      .slice(1) // skip base prompt
      .map(s => s.replace(/^[^\n]*\n/, "").trim()); // strip "— Session #N" header line
    const { isDuplicate, conflictingSection } = isThemeDuplicate(newText, existingSections);
    if (isDuplicate) {
      console.log(`  ⏭ System prompt addition blocked — theme already covered (${conflictingSection?.slice(0, 60) ?? "existing section"}). Express this insight as a concrete rule instead.`);
      axiomOutput.systemPromptAdditions = "";
    }
  }

  if (axiomOutput.systemPromptAdditions?.trim()) {
    const addition =
      `\n\n## Evolved — Session #${sessionNumber}\n\n` +
      axiomOutput.systemPromptAdditions.trim() + "\n";

    if (newSystemPrompt.length + addition.length <= maxLen) {
      newSystemPrompt = newSystemPrompt.trimEnd() + addition;
    } else {
      // Prune oldest evolved sections to make room, keeping base prompt intact
      const baseEnd     = newSystemPrompt.indexOf("\n\n## Evolved");
      const basePrompt  = baseEnd === -1 ? newSystemPrompt : newSystemPrompt.slice(0, baseEnd);
      const evolvedPart = baseEnd === -1 ? "" : newSystemPrompt.slice(baseEnd);

      const sections = evolvedPart.split(/\n\n(?=## Evolved)/).filter(Boolean);
      while (
        sections.length > 0 &&
        basePrompt.length + sections.join("\n\n").length + addition.length > maxLen
      ) {
        sections.shift(); // drop oldest evolved section
      }

      newSystemPrompt =
        basePrompt.trimEnd() +
        (sections.length > 0 ? "\n\n" + sections.join("\n\n").trimEnd() : "") +
        addition;

      console.log(`  ⚠ System prompt pruned — dropped oldest evolution(s) to stay under ${maxLen} chars`);
    }
  }

  fs.writeFileSync(SYSTEM_PROMPT_PATH, newSystemPrompt);
}

// ── Init memory if fresh install ───────────────────────────

export function initMemoryIfNeeded(): void {
  fs.mkdirSync(MEMORY_DIR, { recursive: true });
  if (!fs.existsSync(SYSTEM_PROMPT_PATH)) {
    console.log("  Memory: will initialize on first session.");
  }
}
