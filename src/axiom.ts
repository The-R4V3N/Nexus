// ============================================================
// NEXUS — AXIOM Module
// Self-reflection engine: rewrites its own rules & system prompt
// ============================================================

import Anthropic from "@anthropic-ai/sdk";
import * as fs from "fs";
import * as path from "path";
import type {
  OracleAnalysis,
  AxiomReflection,
  AnalysisRules,
  RuleUpdate,
} from "./types";

const MEMORY_DIR = path.join(process.cwd(), "memory");
const SYSTEM_PROMPT_PATH = path.join(MEMORY_DIR, "system-prompt.md");
const ANALYSIS_RULES_PATH = path.join(MEMORY_DIR, "analysis-rules.json");

// ── AXIOM Reflection ───────────────────────────────────────

export async function runAxiomReflection(
  client: Anthropic,
  oracle: OracleAnalysis,
  sessionNumber: number,
  previousSessions: string,
  communityIssues: string = ""
): Promise<AxiomReflection> {
  const currentSystemPrompt = fs.existsSync(SYSTEM_PROMPT_PATH)
    ? fs.readFileSync(SYSTEM_PROMPT_PATH, "utf-8")
    : "";

  const currentRules: AnalysisRules = fs.existsSync(ANALYSIS_RULES_PATH)
    ? JSON.parse(fs.readFileSync(ANALYSIS_RULES_PATH, "utf-8"))
    : { rules: [], version: 1, lastUpdated: "", focusInstruments: [], sessionNotes: "" };

  const systemMessage = `You are NEXUS AXIOM, the self-reflection engine of the NEXUS market intelligence system.
Your purpose is to critique the analysis just produced, identify cognitive biases and gaps, then generate precise updates to improve future performance.
You are honest, ruthless, and specific. You do not tolerate vague analysis or lazy conclusions.
You speak in first person as NEXUS reflecting on itself.`;

  const userMessage = `
## Session #${sessionNumber} — AXIOM Self-Reflection

### What I just analyzed:
${oracle.analysis}

### Setups I identified: ${oracle.setups.length}
${oracle.setups.map((s) => `- ${s.instrument}: ${s.type} ${s.direction} — ${s.description}`).join("\n")}

### My confidence: ${oracle.confidence}/100
### Market bias: ${oracle.bias.overall} — ${oracle.bias.notes}

### My current rules (${currentRules.rules.length} rules, v${currentRules.version}):
${currentRules.rules.map((r) => `[${r.id}] [W:${r.weight}] ${r.description}`).join("\n")}

### Recent session history:
${previousSessions || "No previous sessions."}

${communityIssues ? "### Community input this session:\n" + communityIssues : "### Community input: none this session."}

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
  "systemPromptAdditions": "Any new section or modification to add to the system prompt (empty string if none)"
}

Only create new rules if the session revealed a genuine gap not covered. Only modify rules if you have a specific, better formulation. Be surgical.`;

  const response = await client.messages.create({
    model: "claude-sonnet-4-20250514",
    max_tokens: 4096,
    system: systemMessage,
    messages: [{ role: "user", content: userMessage }],
  });

  const rawText = response.content
    .filter((b) => b.type === "text")
    .map((b) => (b as { type: "text"; text: string }).text)
    .join("");

  const jsonText = rawText.replace(/```json\n?|```\n?/g, "").trim();
  const parsed = JSON.parse(jsonText);

  // Apply rule updates to memory
  const reflection: AxiomReflection = {
    timestamp: new Date(),
    sessionId: oracle.sessionId,
    whatWorked: parsed.whatWorked ?? "",
    whatFailed: parsed.whatFailed ?? "",
    cognitiveBiases: parsed.cognitiveBiases ?? [],
    ruleUpdates: parsed.ruleUpdates ?? [],
    newSystemPromptSections: parsed.systemPromptAdditions ?? "",
    evolutionSummary: parsed.evolutionSummary ?? "",
  };

  // Persist the evolved memory
  await evolveMemory(currentRules, currentSystemPrompt, parsed, sessionNumber);

  return reflection;
}

// ── Memory Evolution ───────────────────────────────────────

async function evolveMemory(
  currentRules: AnalysisRules,
  currentSystemPrompt: string,
  axiomOutput: {
    ruleUpdates?: RuleUpdate[];
    newRules?: Array<{ id: string; category: string; description: string; weight: number }>;
    systemPromptAdditions?: string;
  },
  sessionNumber: number
): Promise<void> {
  fs.mkdirSync(MEMORY_DIR, { recursive: true });

  // ── Update rules ──
  const updatedRules = { ...currentRules };

  // Apply modifications and removals
  if (axiomOutput.ruleUpdates) {
    for (const update of axiomOutput.ruleUpdates) {
      const idx = updatedRules.rules.findIndex((r) => r.id === update.ruleId);
      if (idx === -1) continue;

      if (update.type === "remove") {
        updatedRules.rules.splice(idx, 1);
      } else if (update.type === "modify" && update.after) {
        updatedRules.rules[idx] = {
          ...updatedRules.rules[idx],
          description: update.after,
          lastModifiedSession: sessionNumber,
        };
      }
    }
  }

  // Add new rules
  if (axiomOutput.newRules) {
    for (const nr of axiomOutput.newRules) {
      // Don't add duplicates
      if (!updatedRules.rules.find((r) => r.id === nr.id)) {
        updatedRules.rules.push({
          id: nr.id,
          category: nr.category,
          description: nr.description,
          weight: nr.weight,
          addedSession: sessionNumber,
          lastModifiedSession: sessionNumber,
        });
      }
    }
  }

  updatedRules.version = currentRules.version + 1;
  updatedRules.lastUpdated = new Date().toISOString();
  updatedRules.sessionNotes = `Last updated: Session #${sessionNumber}`;

  fs.writeFileSync(ANALYSIS_RULES_PATH, JSON.stringify(updatedRules, null, 2));

  // ── Update system prompt ──
  let newSystemPrompt = currentSystemPrompt;
  if (axiomOutput.systemPromptAdditions && axiomOutput.systemPromptAdditions.trim()) {
    newSystemPrompt +=
      `\n\n## Evolved — Session #${sessionNumber}\n` +
      axiomOutput.systemPromptAdditions.trim();
  }

  fs.writeFileSync(SYSTEM_PROMPT_PATH, newSystemPrompt);
}

// ── Init memory if fresh install ───────────────────────────

export function initMemoryIfNeeded(): void {
  fs.mkdirSync(MEMORY_DIR, { recursive: true });

  if (!fs.existsSync(SYSTEM_PROMPT_PATH)) {
    // Will be created by oracle.ts defaults on first load
    console.log("  Memory: will initialize on first session.");
  }
}