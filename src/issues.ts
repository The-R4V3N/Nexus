// ============================================================
// NEXUS — Community Issues Module
// Fetches open GitHub issues tagged nexus-input
// ============================================================

import { sanitizeAllIssues, IssueSecurityReport } from "./security";

export interface CommunityIssue {
    number: number;
    title: string;
    body: string;
    label: "feedback" | "challenge" | "suggestion" | "unknown";
    author: string;
    createdAt: string;
    reactions: number;
    url: string;
}

// ── Fetch issues from GitHub API ───────────────────────────

export async function fetchCommunityIssues(): Promise<CommunityIssue[]> {
    const repo = process.env.GITHUB_REPOSITORY ?? "The-R4V3N/Nexus";
    const token = process.env.GITHUB_TOKEN;

    const headers: Record<string, string> = {
        "Accept": "application/vnd.github+json",
        "User-Agent": "NEXUS-Agent",
    };

    if (token) headers["Authorization"] = `Bearer ${token}`;

    try {
        const url = `https://api.github.com/repos/${repo}/issues?labels=nexus-input&state=open&per_page=20&sort=reactions&direction=desc`;
        const res = await fetch(url, { headers });

        if (!res.ok) {
            console.warn(`  ⚠ GitHub API returned ${res.status} — skipping community issues`);
            return [];
        }

        const data = await res.json() as any[];

        return data
            .filter((issue: any) => !issue.pull_request) // exclude PRs
            .map((issue: any) => ({
                number: issue.number,
                title: issue.title,
                body: (issue.body ?? "").slice(0, 2000), // cap length
                label: extractLabel(issue.labels),
                author: issue.user?.login ?? "unknown",
                createdAt: issue.created_at,
                reactions: issue.reactions?.total_count ?? 0,
                url: issue.html_url,
            }));
    } catch (err) {
        console.warn(`  ⚠ Could not fetch community issues: ${err}`);
        return [];
    }
}

function extractLabel(labels: any[]): CommunityIssue["label"] {
    const names = labels.map((l: any) => l.name as string);
    if (names.includes("feedback")) return "feedback";
    if (names.includes("challenge")) return "challenge";
    if (names.includes("suggestion")) return "suggestion";
    return "unknown";
}

// ── Format for prompt injection ────────────────────────────

export function formatIssuesForPrompt(issues: CommunityIssue[]): string {
    if (issues.length === 0) return "";

    // Run all issues through security sanitizer before injecting into prompt
    const report: IssueSecurityReport = sanitizeAllIssues(
        issues.map((i) => ({
            number: i.number,
            title: i.title,
            body: i.body,
            reactions: i.reactions,
        }))
    );

    if (report.blocked.length > 0) {
        console.warn(`  🛡️  Security: blocked ${report.blocked.length} issue(s) — ${report.blocked.map(n => `#${n}`).join(", ")}`);
    }

    if (report.warnings.length > 0) {
        for (const w of report.warnings) console.warn(`  ⚠ Security: ${w}`);
    }

    if (!report.safe.trim()) return "";

    const lines = [
        "=== COMMUNITY INPUT ===",
        `${report.usedIssues} of ${report.totalIssues} issue(s) passed security review.`,
        "These are real people giving feedback. Address them honestly.\n",
        report.safe,
    ];

    return lines.join("\n");
}