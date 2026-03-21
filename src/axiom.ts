// ============================================================
// NEXUS — AXIOM Module
// Self-reflection engine: rewrites its own rules & system prompt
// ============================================================

import Anthropic from "@anthropic-ai/sdk";
import { createSelfTask, closeSelfTask, SelfTask } from "./self-tasks";
import { sanitizeAxiomOutput, getMaxOutputTokens, getMaxSystemPromptLength } from "./security";
import { validateAxiomOutput, logFailure } from "./validate";
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
  RuleUpdate,
  ForgeRequest,
} from "./types";


// ── Build codebase context for AXIOM ──────────────────────
// Injects file listing + contents of small/relevant files so
// AXIOM can write precise codeChanges instructions.

const MAX_FILE_INJECT_CHARS = 3000; // per file
const ALWAYS_INJECT = ["journal.ts", "agent.ts"]; // always show these to AXIOM

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
  noChangeStreak:    number,
  setupOutcomes:     string,
  currentRules:      AnalysisRules,
  identityContext:   string
): { systemMessage: string; userMessage: string } {
  const systemMessage = `You are NEXUS AXIOM, the self-reflection engine of the NEXUS market intelligence system.
Your purpose is to critique the analysis just produced, identify cognitive biases and gaps, then generate precise updates to improve future performance.
You are honest, ruthless, and specific. You do not tolerate vague analysis or lazy conclusions.
You speak in first person as NEXUS reflecting on itself.`;

  const userMessage = `
## Session #${sessionNumber} — AXIOM Self-Reflection

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
### Market bias: ${oracle.bias.overall} — ${oracle.bias.notes}

### Compliance check (evaluate THIS session, not past patterns):
- Confidence breakdown in analysis text: ${/confidence.*\d+%.*\d+%/i.test(oracle.analysis) ? "YES" : "NO"}
- Quantified moves (pips/points/%): ${/\d+(\.\d+)?\s*(pips?|points?|%)/i.test(oracle.analysis) ? "YES" : "NO"}
- All setups complete (entry/stop/target/RR/TF): ${oracle.setups.every((s: any) => (s as any).entry != null && (s as any).stop != null && (s as any).target != null && (s as any).RR != null && (s as any).timeframe) ? "YES — all " + oracle.setups.length + " setups have required fields" : "NO — some setups missing fields"}
- Mixed bias justified: ${oracle.bias.overall !== "mixed" ? "N/A (bias is " + oracle.bias.overall + ")" : /conflict|divergen|breakdown/i.test(oracle.bias.notes) ? "YES" : "NO"}

IMPORTANT ANTI-REPETITION RULES:
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
Your self-critiques are repeating without action. This session, you MUST propose
at least ONE concrete change — a rule weight adjustment, wording refinement,
new rule, system prompt addition, or code change. Reflection without action is not evolution.
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
- Set newSelfTasks to [] if you have 5+ open self-tasks already.

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
- If you have 25+ rules already, prefer modifying existing rules over adding new ones.
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
  currentRules: AnalysisRules
): any {
  const jsonText = extractJSONFromResponse(rawText);

  let rawParsed: any;

  try {
    rawParsed = JSON.parse(jsonText);
  } catch {
    // Try to salvage truncated JSON
    const salvaged = salvageJSON(jsonText);
    if (salvaged) {
      rawParsed = salvaged;
      console.warn("  ⚠ AXIOM returned malformed JSON — salvaged partial response");
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

  // ── Validate AXIOM output ──
  const axiomEntries = loadAllJournalEntries();
  const axiomValidation = validateAxiomOutput(rawParsed, sessionNumber, axiomEntries);
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
  const secResult = sanitizeAxiomOutput(rawParsed, sessionNumber, currentRules.rules.length);
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
  noChangeStreak:         number = 0,
  setupOutcomes:          string = ""
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
    currentRules, identityContext
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

  const parsed = parseAxiomResponse(rawText, sessionNumber, currentRules);

  const reflection: AxiomReflection = {
    timestamp:               new Date(),
    sessionId:               oracle.sessionId,
    whatWorked:              parsed.whatWorked       ?? "",
    whatFailed:              parsed.whatFailed       ?? "",
    cognitiveBiases:         parsed.cognitiveBiases  ?? [],
    ruleUpdates:             parsed.ruleUpdates      ?? [],
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

  fs.writeFileSync(ANALYSIS_RULES_PATH, JSON.stringify(updatedRules, null, 2));

  // ── Update system prompt (capped to prevent unbounded growth) ──
  let newSystemPrompt = currentSystemPrompt;
  const maxLen        = getMaxSystemPromptLength();

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
