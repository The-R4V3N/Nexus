import { sanitizeUnicode } from "./issues";

// ============================================================
// NEXUS — Self-Task Module
// NEXUS opens GitHub issues on itself and closes them when solved
// ============================================================

export interface SelfTask {
  title:       string;
  body:        string;
  category:    "blind-spot" | "bias" | "rule-gap" | "new-concept" | "correlation";
  priority:    "high" | "medium" | "low";
  sessionOpened: number;
}

export interface OpenSelfTask {
  number:    number;
  title:     string;
  body:      string;
  category:  string;
  sessionOpened: number;
  url:       string;
}

// ── GitHub API helpers ─────────────────────────────────────

function getHeaders(): Record<string, string> {
  const token = process.env.GITHUB_TOKEN;
  const headers: Record<string, string> = {
    "Accept":       "application/vnd.github+json",
    "Content-Type": "application/json",
    "User-Agent":   "NEXUS-Agent",
  };
  if (token) headers["Authorization"] = `Bearer ${token}`;
  return headers;
}

function getRepo(): string {
  return process.env.GITHUB_REPOSITORY ?? "The-R4V3N/Nexus";
}

// ── Duplicate detection ─────────────────────────────────────

function isDuplicate(
  newTitle: string,
  existingTasks: OpenSelfTask[]
): boolean {
  const normalize = (s: string) =>
    s.toLowerCase().replace(/[^a-z0-9]/g, " ").replace(/\s+/g, " ").trim();

  const newNorm = normalize(newTitle);

  for (const t of existingTasks) {
    const existNorm = normalize(t.title);

    // Exact match after normalization
    if (newNorm === existNorm) return true;

    // High word overlap (>70% of words shared)
    const newWords  = new Set(newNorm.split(" "));
    const existWords = new Set(existNorm.split(" "));
    const shared = [...newWords].filter((w) => existWords.has(w) && w.length > 2).length;
    const maxWords = Math.max(newWords.size, existWords.size);
    if (maxWords > 0 && shared / maxWords > 0.7) return true;
  }

  return false;
}

// ── Create a self-task issue ───────────────────────────────

let _cachedOpenTasks: OpenSelfTask[] | null = null;

export function setCachedOpenTasks(tasks: OpenSelfTask[]): void {
  _cachedOpenTasks = tasks;
}

export async function createSelfTask(
  task: SelfTask,
  sessionNumber: number
): Promise<number | null> {
  // Dedup: skip if a similar task already exists
  const existing = _cachedOpenTasks ?? await fetchOpenSelfTasks();
  if (isDuplicate(task.title, existing)) {
    console.log(`    ⏭ Skipped duplicate self-task: "${task.title}"`);
    return null;
  }

  const repo    = getRepo();
  const headers = getHeaders();

  const body = `${task.body}

---
**Filed by NEXUS autonomously**
- Session: #${sessionNumber}
- Category: ${task.category}
- Priority: ${task.priority}
- This issue will be addressed and closed by NEXUS in a future session.`;

  try {
    const res = await fetch(`https://api.github.com/repos/${repo}/issues`, {
      method: "POST",
      headers,
      signal: AbortSignal.timeout(20000),
      body: JSON.stringify({
        title:  `[SELF-TASK] ${task.title}`,
        body,
        labels: ["nexus-self-task", task.category, `priority-${task.priority}`],
      }),
    });

    if (!res.ok) {
      const err = await res.text();
      console.warn(`  ⚠ Could not create self-task: ${res.status} ${err}`);
      return null;
    }

    const data = await res.json() as any;
    return data.number;
  } catch (err) {
    console.warn(`  ⚠ Self-task creation failed: ${err}`);
    return null;
  }
}

// ── Fetch open self-tasks ──────────────────────────────────

export async function fetchOpenSelfTasks(): Promise<OpenSelfTask[]> {
  const repo    = getRepo();
  const headers = getHeaders();

  try {
    const res = await fetch(
      `https://api.github.com/repos/${repo}/issues?labels=nexus-self-task&state=open&per_page=20`,
      { headers, signal: AbortSignal.timeout(20000) }
    );

    if (!res.ok) return [];

    const data = await res.json() as any[];

    return data
      .filter((i: any) => !i.pull_request)
      .map((i: any) => {
        const categoryLabel = i.labels
          .map((l: any) => l.name)
          .find((n: string) => ["blind-spot","bias","rule-gap","new-concept","correlation"].includes(n)) ?? "unknown";

        // Extract session number from body
        const sessionMatch = i.body?.match(/Session: #(\d+)/);
        const sessionOpened = sessionMatch ? parseInt(sessionMatch[1]) : 0;

        return {
          number:        i.number,
          title:         sanitizeUnicode(i.title.replace(/[\u{1F300}-\u{1FFFF}][\uFE0F]?\s?\[SELF-TASK\]\s?/u, "")),
          body:          sanitizeUnicode((i.body ?? "").slice(0, 1500)),
          category:      categoryLabel,
          sessionOpened,
          url:           i.html_url,
        };
      });
  } catch (err) {
    console.warn(`  ⚠ Could not fetch self-tasks: ${err}`);
    return [];
  }
}

// ── Close a resolved self-task ─────────────────────────────

export async function closeSelfTask(
  issueNumber: number,
  resolutionComment: string,
  sessionNumber: number
): Promise<boolean> {
  const repo    = getRepo();
  const headers = getHeaders();

  try {
    // Post resolution comment
    await fetch(`https://api.github.com/repos/${repo}/issues/${issueNumber}/comments`, {
      method: "POST",
      headers,
      signal: AbortSignal.timeout(20000),
      body: JSON.stringify({
        body: `## ✅ Resolved by NEXUS — Session #${sessionNumber}\n\n${resolutionComment}`,
      }),
    });

    // Close the issue
    const res = await fetch(`https://api.github.com/repos/${repo}/issues/${issueNumber}`, {
      method:  "PATCH",
      headers,
      signal: AbortSignal.timeout(20000),
      body: JSON.stringify({
        state:        "closed",
        state_reason: "completed",
      }),
    });

    return res.ok;
  } catch (err) {
    console.warn(`  ⚠ Could not close self-task #${issueNumber}: ${err}`);
    return false;
  }
}

// ── Format open self-tasks for prompt ─────────────────────

export function formatSelfTasksForPrompt(tasks: OpenSelfTask[]): string {
  if (tasks.length === 0) return "";

  const lines = [
    "=== MY OPEN SELF-TASKS ===",
    `I filed ${tasks.length} task(s) for myself in previous sessions. I should address them if I have enough information this session.\n`,
  ];

  for (const t of tasks) {
    lines.push(`[#${t.number}] [${t.category.toUpperCase()}] ${t.title}`);
    lines.push(`Opened: Session #${t.sessionOpened} | ${t.url}`);
    lines.push(t.body.split("---")[0].trim()); // just the description, not the metadata
    lines.push("");
  }

  return lines.join("\n");
}
