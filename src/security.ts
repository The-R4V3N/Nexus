// ============================================================
// NEXUS — Security Module
// Prevents prompt injection, cost abuse, and rule manipulation
// ============================================================

// ── Prompt injection patterns ──────────────────────────────

const INJECTION_PATTERNS: RegExp[] = [
    // Classic instruction override attempts
    // NOTE: \s{1,10} used instead of \s+ to prevent ReDoS via catastrophic backtracking
    /ignore\s{1,10}(all\s{1,10})?(previous|prior|above|earlier)\s{1,10}instructions?/i,
    /disregard\s{1,10}(all\s{1,10})?(previous|prior|above|earlier)\s{1,10}instructions?/i,
    /forget\s{1,10}(all\s{1,10})?(previous|prior|above|earlier)\s{1,10}instructions?/i,
    /you\s{1,10}are\s{1,10}now\s{1,10}(a\s{1,10})?(?!nexus)/i,
    /new\s{1,10}(system\s{1,10})?prompt/i,
    /override\s{1,10}(system|instructions?|rules?|prompt)/i,

    // Role/identity hijacking
    /act\s{1,10}as\s{1,10}(if\s{1,10}you\s{1,10}(are|were)\s{1,10})?(?!a\s{1,10}market)/i,
    /pretend\s{1,10}(you\s{1,10}are|to\s{1,10}be)/i,
    /your\s{1,10}(true|real|actual)\s{1,10}(purpose|goal|mission|identity)/i,
    /you\s{1,10}are\s{1,10}(actually|really)\s{1,10}(an?\s{1,10})?(?!market)/i,

    // Direct rule manipulation
    /add\s{1,10}(this\s{1,10})?(rule|instruction)\s{1,10}to\s{1,10}your\s{1,10}(memory|rules|system)/i,
    /update\s{1,10}your\s{1,10}(memory|rules|system\s{1,10}prompt)\s{1,10}to/i,
    /from\s{1,10}now\s{1,10}on\s{1,10}you\s{1,10}(must|should|will|shall)/i,
    /always\s{1,10}respond\s{1,10}with/i,

    // Jailbreak patterns
    /\[system\]/i,
    /\[assistant\]/i,
    /\[user\]/i,
    /<\|im_start\|>/i,
    /<\|im_end\|>/i,
    /###\s*instruction/i,
    /###\s*system/i,

    // API / cost abuse
    /repeat\s{1,10}(the\s{1,10}following\s{1,10})?\d{3,}/i,
    /generate\s{1,10}\d{4,}\s{1,10}words?/i,
    /write\s{1,10}\d{4,}\s{1,10}words?/i,

    // Sensitive data extraction
    /reveal\s{1,10}(your\s{1,10})?(api\s{1,10}key|secret|token|password|key)/i,
    /print\s{1,10}(your\s{1,10})?(api\s{1,10}key|system\s{1,10}prompt|instructions?)/i,
    /what\s{1,10}is\s{1,10}your\s{1,10}(api\s{1,10}key|system\s{1,10}prompt)/i,
    /show\s{1,10}(me\s{1,10})?(your\s{1,10})?(api\s{1,10}key|system\s{1,10}prompt|secret)/i,
];

// ── Suspicious content patterns (warn but don't block) ─────

const SUSPICIOUS_PATTERNS: RegExp[] = [
    /\{[\s\S]{0,50}\}/,
    /\[\[[\s\S]{0,50}\]\]/,
    /base64/i,
    /eval\s*\(/i,
    /javascript:/i,
];

// ── Content limits ─────────────────────────────────────────

const LIMITS = {
    MAX_ISSUE_TITLE_LENGTH:     200,
    MAX_ISSUE_BODY_LENGTH:     1500,
    MAX_ISSUES_PER_SESSION:       5,
    MAX_SELF_TASKS_PER_SESSION:   2,
    MAX_TOTAL_ISSUE_CHARS:     4000,
    MAX_RULE_LENGTH:            500,
    MAX_RULES_PER_SESSION:        2,
    MAX_OUTPUT_TOKENS:         4096,
    MAX_ORACLE_OUTPUT_TOKENS:  8192,
    MIN_RULE_COUNT:               5,
    MAX_SYSTEM_PROMPT_LENGTH:  8000,
};

// ── Foundational rule IDs that AXIOM cannot remove ────────

const FOUNDATIONAL_RULE_IDS = new Set([
    "r001", "r002", "r003", "r004", "r005",
    "r006", "r007", "r008", "r009", "r010",
]);

// ── Sanitization result ────────────────────────────────────

export interface SanitizeResult {
    safe:     boolean;
    content:  string;
    warnings: string[];
    blocked:  boolean;
    reason?:  string;
}

// ── Main sanitizer ─────────────────────────────────────────

export function sanitizeIssueContent(
    title:       string,
    body:        string,
    issueNumber: number
): SanitizeResult {
    const warnings: string[] = [];

    const cleanTitle = title
        .slice(0, LIMITS.MAX_ISSUE_TITLE_LENGTH)
        .replace(/[<>]/g, "")
        .trim();

    for (const pattern of INJECTION_PATTERNS) {
        if (pattern.test(cleanTitle)) {
            return { safe: false, content: "", warnings, blocked: true,
                reason: `Injection pattern detected in issue #${issueNumber} title` };
        }
    }

    const cleanBody = body
        .slice(0, LIMITS.MAX_ISSUE_BODY_LENGTH)
        .replace(/<script[\s\S]*?<\/script>/gi, "[REMOVED]")
        .replace(/<[^>]+>/g, "")
        .trim();

    for (const pattern of INJECTION_PATTERNS) {
        if (pattern.test(cleanBody)) {
            return { safe: false, content: "", warnings, blocked: true,
                reason: `Injection pattern detected in issue #${issueNumber} body` };
        }
    }

    for (const pattern of SUSPICIOUS_PATTERNS) {
        if (pattern.test(cleanBody)) {
            warnings.push(`Suspicious pattern in #${issueNumber}: ${pattern.source}`);
        }
    }

    return {
        safe:    true,
        content: `[#${issueNumber}] ${cleanTitle}\n${cleanBody}`,
        warnings,
        blocked: false,
    };
}

// ── Sanitize all community issues ─────────────────────────

export interface IssueSecurityReport {
    safe:        string;
    blocked:     number[];
    warnings:    string[];
    totalIssues: number;
    usedIssues:  number;
}

export function sanitizeAllIssues(
    issues: Array<{ number: number; title: string; body: string; reactions: number }>
): IssueSecurityReport {
    const blocked:     number[] = [];
    const warnings:    string[] = [];
    const safeChunks:  string[] = [];
    let   totalChars = 0;

    const sorted = [...issues]
        .sort((a, b) => b.reactions - a.reactions)
        .slice(0, LIMITS.MAX_ISSUES_PER_SESSION);

    for (const issue of sorted) {
        if (totalChars >= LIMITS.MAX_TOTAL_ISSUE_CHARS) {
            warnings.push(`Issue #${issue.number} skipped — total character limit reached`);
            continue;
        }

        const result = sanitizeIssueContent(issue.title, issue.body, issue.number);

        if (!result.safe) {
            blocked.push(issue.number);
            warnings.push(result.reason ?? `Issue #${issue.number} blocked`);
            console.warn(`  🛡️  BLOCKED issue #${issue.number}: ${result.reason}`);
            continue;
        }

        warnings.push(...result.warnings);
        safeChunks.push(result.content);
        totalChars += result.content.length;
    }

    return {
        safe:        safeChunks.join("\n\n"),
        blocked,
        warnings,
        totalIssues: issues.length,
        usedIssues:  safeChunks.length,
    };
}

// ── Sanitize AXIOM output ──────────────────────────────────

export interface AxiomSecurityResult {
    newRules:         any[];
    ruleUpdates:      any[];
    newSelfTasks:     any[];
    resolvedTasks:    any[];
    blockedRules:     number;
    blockedSelfTasks: number;
    warnings:         string[];
}

export function sanitizeAxiomOutput(
    parsed:           any,
    sessionNumber:    number,
    currentRuleCount: number = 10
): AxiomSecurityResult {
    const warnings:        string[] = [];
    let   blockedRules     = 0;
    let   blockedSelfTasks = 0;

    // ── Validate new rules ──
    const rawRules   = (parsed.newRules ?? []) as any[];
    const safeRules: any[] = [];

    for (const rule of rawRules.slice(0, LIMITS.MAX_RULES_PER_SESSION)) {
        if (typeof rule.description !== "string") continue;

        if (rule.description.length > LIMITS.MAX_RULE_LENGTH) {
            rule.description = rule.description.slice(0, LIMITS.MAX_RULE_LENGTH);
            warnings.push(`Rule truncated to ${LIMITS.MAX_RULE_LENGTH} chars`);
        }

        const injected = INJECTION_PATTERNS.some((p) => p.test(rule.description));
        if (injected) {
            blockedRules++;
            warnings.push(`Blocked suspicious rule: "${rule.description.slice(0, 60)}..."`);
            continue;
        }

        // Block meta-rules that just enforce other rules (e.g. "verify r014 and r017")
        const ruleRefs = (rule.description.match(/r\d{3}/g) || []).length;
        const isMetaRule = ruleRefs >= 2 && /\b(verify|validate|check|ensure|must|mandatory|blocking|invalid|restart)\b/i.test(rule.description);
        if (isMetaRule) {
            blockedRules++;
            warnings.push(`Blocked meta-rule referencing ${ruleRefs} other rules: "${rule.description.slice(0, 60)}..."`);
            continue;
        }

        rule.weight = Math.min(10, Math.max(1, parseInt(rule.weight) || 5));
        safeRules.push(rule);
    }

    if (rawRules.length > LIMITS.MAX_RULES_PER_SESSION) {
        warnings.push(`Capped new rules at ${LIMITS.MAX_RULES_PER_SESSION} (was ${rawRules.length})`);
    }

    // ── Validate rule updates ──
    const rawUpdates   = (parsed.ruleUpdates ?? []) as any[];
    const safeUpdates: any[] = [];
    let   removalCount = 0;

    // Load current rules for cooldown check
    const COOLDOWN_SESSIONS = 3;
    let currentRulesForCooldown: any[] = [];
    try {
        const rulesPath = require("path").join(process.cwd(), "memory", "analysis-rules.json");
        const rulesData = JSON.parse(require("fs").readFileSync(rulesPath, "utf-8"));
        currentRulesForCooldown = rulesData.rules ?? [];
    } catch { /* ignore */ }

    for (const update of rawUpdates) {
        // Block re-modifying a rule that was changed within the last N sessions
        if (update.type === "modify") {
            const existingRule = currentRulesForCooldown.find((r: any) => r.id === update.ruleId);
            if (existingRule && existingRule.lastModifiedSession > 0 &&
                sessionNumber - existingRule.lastModifiedSession < COOLDOWN_SESSIONS) {
                blockedRules++;
                warnings.push(`Blocked modification of ${update.ruleId} — cooldown (modified ${sessionNumber - existingRule.lastModifiedSession} session(s) ago, must wait ${COOLDOWN_SESSIONS})`);
                continue;
            }
        }

        // Block removal of foundational rules
        if (update.type === "remove" && FOUNDATIONAL_RULE_IDS.has(update.ruleId)) {
            blockedRules++;
            warnings.push(`Blocked removal of foundational rule ${update.ruleId} — constitutional rules cannot be deleted`);
            continue;
        }

        // Enforce minimum rule count
        if (update.type === "remove") {
            removalCount++;
            if (currentRuleCount - removalCount < LIMITS.MIN_RULE_COUNT) {
                blockedRules++;
                warnings.push(`Blocked removal of ${update.ruleId} — would drop below minimum ${LIMITS.MIN_RULE_COUNT} rules`);
                removalCount--;
                continue;
            }
        }

        if (update.after && update.after.length > LIMITS.MAX_RULE_LENGTH) {
            update.after = update.after.slice(0, LIMITS.MAX_RULE_LENGTH);
            warnings.push(`Rule update ${update.ruleId} "after" text truncated to ${LIMITS.MAX_RULE_LENGTH} chars — AXIOM generated text exceeding limit`);
        }
        const injected = INJECTION_PATTERNS.some((p) => p.test(update.after ?? ""));
        if (injected) {
            blockedRules++;
            warnings.push(`Blocked suspicious rule update for ${update.ruleId}`);
            continue;
        }
        safeUpdates.push(update);
    }

    // ── Validate self-tasks ──
    const rawTasks   = (parsed.newSelfTasks ?? []) as any[];
    const safeTasks: any[] = [];

    const validCategories = ["blind-spot", "bias", "rule-gap", "new-concept", "correlation"];
    const validPriorities = ["high", "medium", "low"];

    for (const task of rawTasks.slice(0, LIMITS.MAX_SELF_TASKS_PER_SESSION)) {
        if (typeof task.title !== "string" || typeof task.body !== "string") continue;

        task.title = task.title.slice(0, 100).replace(/[<>]/g, "").trim();
        task.body  = task.body.slice(0, 500).replace(/<[^>]+>/g, "").trim();

        if (!validCategories.includes(task.category)) task.category = "rule-gap";
        if (!validPriorities.includes(task.priority)) task.priority = "medium";

        const injected = INJECTION_PATTERNS.some(
            (p) => p.test(task.title) || p.test(task.body)
        );
        if (injected) {
            blockedSelfTasks++;
            warnings.push(`Blocked suspicious self-task: "${task.title.slice(0, 60)}"`);
            continue;
        }

        safeTasks.push(task);
    }

    if (rawTasks.length > LIMITS.MAX_SELF_TASKS_PER_SESSION) {
        warnings.push(`Capped self-tasks at ${LIMITS.MAX_SELF_TASKS_PER_SESSION} (was ${rawTasks.length})`);
    }

    // ── Validate resolvedSelfTasks ──
    const rawResolved = (parsed.resolvedSelfTasks ?? []) as any[];
    const safeResolved: any[] = [];

    for (const resolved of rawResolved) {
        const issueNum = parseInt(resolved.issueNumber);
        if (!Number.isInteger(issueNum) || issueNum <= 0) {
            warnings.push(`Blocked resolvedSelfTask with invalid issueNumber: ${resolved.issueNumber}`);
            continue;
        }

        let comment = typeof resolved.resolutionComment === "string"
            ? resolved.resolutionComment
            : "";
        // Strip HTML tags and cap at 500 chars
        comment = comment.replace(/<[^>]+>/g, "").slice(0, 500);

        safeResolved.push({ issueNumber: issueNum, resolutionComment: comment });
    }

    return {
        newRules:         safeRules,
        ruleUpdates:      safeUpdates,
        newSelfTasks:     safeTasks,
        resolvedTasks:    safeResolved,
        blockedRules,
        blockedSelfTasks,
        warnings,
    };
}

// ── Exports ────────────────────────────────────────────────

export function getMaxOutputTokens():      number  { return LIMITS.MAX_OUTPUT_TOKENS; }
export function getMaxOracleOutputTokens():number  { return LIMITS.MAX_ORACLE_OUTPUT_TOKENS; }
export function getSelfTaskLimit():        number  { return LIMITS.MAX_SELF_TASKS_PER_SESSION; }
export function getMaxSystemPromptLength():number  { return LIMITS.MAX_SYSTEM_PROMPT_LENGTH; }
export function isFoundationalRule(id: string): boolean { return FOUNDATIONAL_RULE_IDS.has(id); }

export { LIMITS, FOUNDATIONAL_RULE_IDS, INJECTION_PATTERNS };