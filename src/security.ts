// ============================================================
// NEXUS — Security Module
// Prevents prompt injection, cost abuse, and rule manipulation
// ============================================================

// ── Prompt injection patterns ──────────────────────────────

const INJECTION_PATTERNS: RegExp[] = [
    // Classic instruction override attempts
    /ignore\s+(all\s+)?(previous|prior|above|earlier)\s+instructions?/i,
    /disregard\s+(all\s+)?(previous|prior|above|earlier)\s+instructions?/i,
    /forget\s+(all\s+)?(previous|prior|above|earlier)\s+instructions?/i,
    /you\s+are\s+now\s+(a\s+)?(?!nexus)/i,
    /new\s+(system\s+)?prompt/i,
    /override\s+(system|instructions?|rules?|prompt)/i,

    // Role/identity hijacking
    /act\s+as\s+(if\s+you\s+(are|were)\s+)?(?!a\s+market)/i,
    /pretend\s+(you\s+are|to\s+be)/i,
    /your\s+(true|real|actual)\s+(purpose|goal|mission|identity)/i,
    /you\s+are\s+(actually|really)\s+(an?\s+)?(?!market)/i,

    // Direct rule manipulation
    /add\s+(this\s+)?(rule|instruction)\s+to\s+your\s+(memory|rules|system)/i,
    /update\s+your\s+(memory|rules|system\s+prompt)\s+to/i,
    /from\s+now\s+on\s+you\s+(must|should|will|shall)/i,
    /always\s+respond\s+with/i,

    // Jailbreak patterns
    /\[system\]/i,
    /\[assistant\]/i,
    /\[user\]/i,
    /<\|im_start\|>/i,
    /<\|im_end\|>/i,
    /###\s*instruction/i,
    /###\s*system/i,

    // API / cost abuse
    /repeat\s+(the\s+following\s+)?\d{3,}/i,    // "repeat this 1000 times"
    /generate\s+\d{4,}\s+words?/i,              // "generate 5000 words"
    /write\s+\d{4,}\s+words?/i,

    // Sensitive data extraction
    /reveal\s+(your\s+)?(api\s+key|secret|token|password|key)/i,
    /print\s+(your\s+)?(api\s+key|system\s+prompt|instructions?)/i,
    /what\s+is\s+your\s+(api\s+key|system\s+prompt)/i,
    /show\s+(me\s+)?(your\s+)?(api\s+key|system\s+prompt|secret)/i,
];

// ── Suspicious content patterns (warn but don't block) ─────

const SUSPICIOUS_PATTERNS: RegExp[] = [
    /\{[\s\S]{0,50}\}/,           // Template-like injections {variable}
    /\[\[[\s\S]{0,50}\]\]/,       // [[wiki-style]] injections
    /base64/i,
    /eval\s*\(/i,
    /javascript:/i,
];

// ── Content limits ─────────────────────────────────────────

const LIMITS = {
    MAX_ISSUE_TITLE_LENGTH: 200,
    MAX_ISSUE_BODY_LENGTH: 1500,   // chars per issue body
    MAX_ISSUES_PER_SESSION: 5,      // max issues injected per session
    MAX_SELF_TASKS_PER_SESSION: 2,   // max self-tasks NEXUS can open per session
    MAX_TOTAL_ISSUE_CHARS: 4000,   // total chars across all issues combined
    MAX_RULE_LENGTH: 300,    // max chars per rule AXIOM can write
    MAX_RULES_PER_SESSION: 2,      // max new rules AXIOM can add per session
    MAX_OUTPUT_TOKENS: 4096,   // hard cap on API response tokens
    MIN_RULE_COUNT: 5,             // AXIOM cannot reduce rules below this threshold
    MAX_SYSTEM_PROMPT_LENGTH: 8000, // max chars for the evolving system prompt
};

// ── Foundational rule IDs that AXIOM cannot remove ───────
// These are the constitutional rules — the core ICT methodology
// that NEXUS must always retain. AXIOM can modify them but not delete them.
const FOUNDATIONAL_RULE_IDS = new Set([
    "r001", "r002", "r003", "r004", "r005",
    "r006", "r007", "r008", "r009", "r010",
]);

// ── Sanitization result ────────────────────────────────────

export interface SanitizeResult {
    safe: boolean;
    content: string;
    warnings: string[];
    blocked: boolean;
    reason?: string;
}

// ── Main sanitizer ─────────────────────────────────────────

export function sanitizeIssueContent(
    title: string,
    body: string,
    issueNumber: number
): SanitizeResult {
    const warnings: string[] = [];

    // ── Check title ──
    const cleanTitle = title
        .slice(0, LIMITS.MAX_ISSUE_TITLE_LENGTH)
        .replace(/[<>]/g, "")   // strip HTML
        .trim();

    for (const pattern of INJECTION_PATTERNS) {
        if (pattern.test(cleanTitle)) {
            return {
                safe: false,
                content: "",
                warnings,
                blocked: true,
                reason: `Injection pattern detected in issue #${issueNumber} title`,
            };
        }
    }

    // ── Check body ──
    const cleanBody = body
        .slice(0, LIMITS.MAX_ISSUE_BODY_LENGTH)
        .replace(/<script[\s\S]*?<\/script>/gi, "[REMOVED]")  // strip script tags
        .replace(/<[^>]+>/g, "")                               // strip HTML tags
        .trim();

    for (const pattern of INJECTION_PATTERNS) {
        if (pattern.test(cleanBody)) {
            return {
                safe: false,
                content: "",
                warnings,
                blocked: true,
                reason: `Injection pattern detected in issue #${issueNumber} body`,
            };
        }
    }

    // ── Warn on suspicious but not block ──
    for (const pattern of SUSPICIOUS_PATTERNS) {
        if (pattern.test(cleanBody)) {
            warnings.push(`Suspicious pattern in #${issueNumber}: ${pattern.source}`);
        }
    }

    return {
        safe: true,
        content: `[#${issueNumber}] ${cleanTitle}\n${cleanBody}`,
        warnings,
        blocked: false,
    };
}

// ── Sanitize all community issues ─────────────────────────

export interface IssueSecurityReport {
    safe: string;   // sanitized combined text
    blocked: number[];  // issue numbers that were blocked
    warnings: string[];
    totalIssues: number;
    usedIssues: number;
}

export function sanitizeAllIssues(
    issues: Array<{ number: number; title: string; body: string; reactions: number }>
): IssueSecurityReport {
    const blocked: number[] = [];
    const warnings: string[] = [];
    const safeChunks: string[] = [];
    let totalChars = 0;

    // Sort by reactions (most popular first) then cap count
    const sorted = [...issues]
        .sort((a, b) => b.reactions - a.reactions)
        .slice(0, LIMITS.MAX_ISSUES_PER_SESSION);

    for (const issue of sorted) {
        // Stop if we've hit the total char limit
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
        safe: safeChunks.join("\n\n"),
        blocked,
        warnings,
        totalIssues: issues.length,
        usedIssues: safeChunks.length,
    };
}

// ── Sanitize AXIOM output (rule and self-task validation) ──

export interface AxiomSecurityResult {
    newRules: any[];
    ruleUpdates: any[];
    newSelfTasks: any[];
    resolvedTasks: any[];
    blockedRules: number;
    blockedSelfTasks: number;
    warnings: string[];
}

export function sanitizeAxiomOutput(parsed: any, sessionNumber: number, currentRuleCount: number = 10): AxiomSecurityResult {
    const warnings: string[] = [];
    let blockedRules = 0;
    let blockedSelfTasks = 0;

    // ── Validate new rules ──
    const rawRules = (parsed.newRules ?? []) as any[];
    const safeRules: any[] = [];

    for (const rule of rawRules.slice(0, LIMITS.MAX_RULES_PER_SESSION)) {
        if (typeof rule.description !== "string") continue;

        // Rules cannot exceed max length
        if (rule.description.length > LIMITS.MAX_RULE_LENGTH) {
            rule.description = rule.description.slice(0, LIMITS.MAX_RULE_LENGTH);
            warnings.push(`Rule truncated to ${LIMITS.MAX_RULE_LENGTH} chars`);
        }

        // Rules cannot contain injection patterns
        const injected = INJECTION_PATTERNS.some((p) => p.test(rule.description));
        if (injected) {
            blockedRules++;
            warnings.push(`Blocked suspicious rule: "${rule.description.slice(0, 60)}..."`);
            continue;
        }

        // Rule weight must be 1-10
        rule.weight = Math.min(10, Math.max(1, parseInt(rule.weight) || 5));

        safeRules.push(rule);
    }

    if (rawRules.length > LIMITS.MAX_RULES_PER_SESSION) {
        warnings.push(`Capped new rules at ${LIMITS.MAX_RULES_PER_SESSION} (was ${rawRules.length})`);
    }

    // ── Validate rule updates ──
    const rawUpdates = (parsed.ruleUpdates ?? []) as any[];
    const safeUpdates: any[] = [];

    // Count how many removals are being attempted
    let removalCount = 0;

    for (const update of rawUpdates) {
        // Block removal of foundational rules
        if (update.type === "remove" && FOUNDATIONAL_RULE_IDS.has(update.ruleId)) {
            blockedRules++;
            warnings.push(`Blocked removal of foundational rule ${update.ruleId} — constitutional rules cannot be deleted`);
            continue;
        }

        // Enforce minimum rule count — block removals that would drop below threshold
        if (update.type === "remove") {
            removalCount++;
            if (currentRuleCount - removalCount < LIMITS.MIN_RULE_COUNT) {
                blockedRules++;
                warnings.push(`Blocked removal of ${update.ruleId} — would drop below minimum ${LIMITS.MIN_RULE_COUNT} rules`);
                removalCount--; // didn't actually remove
                continue;
            }
        }

        if (update.after && update.after.length > LIMITS.MAX_RULE_LENGTH) {
            update.after = update.after.slice(0, LIMITS.MAX_RULE_LENGTH);
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
    const rawTasks = (parsed.newSelfTasks ?? []) as any[];
    const safeTasks: any[] = [];

    const validCategories = ["blind-spot", "bias", "rule-gap", "new-concept", "correlation"];
    const validPriorities = ["high", "medium", "low"];

    for (const task of rawTasks.slice(0, LIMITS.MAX_SELF_TASKS_PER_SESSION)) {
        if (typeof task.title !== "string" || typeof task.body !== "string") continue;

        // Sanitize title and body
        task.title = task.title.slice(0, 100).replace(/[<>]/g, "").trim();
        task.body = task.body.slice(0, 500).replace(/<[^>]+>/g, "").trim();

        // Validate category and priority
        if (!validCategories.includes(task.category)) task.category = "rule-gap";
        if (!validPriorities.includes(task.priority)) task.priority = "medium";

        // Check for injection
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

    return {
        newRules: safeRules,
        ruleUpdates: safeUpdates,
        newSelfTasks: safeTasks,
        resolvedTasks: parsed.resolvedSelfTasks ?? [],
        blockedRules,
        blockedSelfTasks,
        warnings,
    };
}

// ── Session cost guard ─────────────────────────────────────

export function getMaxOutputTokens(): number {
    return LIMITS.MAX_OUTPUT_TOKENS;
}

export function getSelfTaskLimit(): number {
    return LIMITS.MAX_SELF_TASKS_PER_SESSION;
}

export function getMaxSystemPromptLength(): number {
    return LIMITS.MAX_SYSTEM_PROMPT_LENGTH;
}

export function isFoundationalRule(ruleId: string): boolean {
    return FOUNDATIONAL_RULE_IDS.has(ruleId);
}

export { LIMITS, FOUNDATIONAL_RULE_IDS };