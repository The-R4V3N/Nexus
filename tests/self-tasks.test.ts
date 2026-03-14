import { describe, it, expect } from "vitest";
import { formatSelfTasksForPrompt, OpenSelfTask } from "../src/self-tasks";

// ── formatSelfTasksForPrompt ────────────────────────────────

describe("formatSelfTasksForPrompt", () => {
  it("returns empty string for no tasks", () => {
    expect(formatSelfTasksForPrompt([])).toBe("");
  });

  it("formats a single task correctly", () => {
    const tasks: OpenSelfTask[] = [{
      number: 42,
      title: "Investigate correlation breakdown",
      body: "Gold and DXY moving together unexpectedly\n---\nFiled by NEXUS",
      category: "correlation",
      sessionOpened: 5,
      url: "https://github.com/example/issues/42",
    }];
    const result = formatSelfTasksForPrompt(tasks);
    expect(result).toContain("=== MY OPEN SELF-TASKS ===");
    expect(result).toContain("1 task(s)");
    expect(result).toContain("[#42]");
    expect(result).toContain("[CORRELATION]");
    expect(result).toContain("Investigate correlation breakdown");
    expect(result).toContain("Session #5");
    expect(result).toContain("Gold and DXY moving together unexpectedly");
    // Should NOT include the metadata after ---
    expect(result).not.toContain("Filed by NEXUS");
  });

  it("formats multiple tasks", () => {
    const tasks: OpenSelfTask[] = [
      {
        number: 1, title: "Task A", body: "Body A",
        category: "bias", sessionOpened: 1, url: "https://example.com/1",
      },
      {
        number: 2, title: "Task B", body: "Body B",
        category: "rule-gap", sessionOpened: 2, url: "https://example.com/2",
      },
    ];
    const result = formatSelfTasksForPrompt(tasks);
    expect(result).toContain("2 task(s)");
    expect(result).toContain("[#1]");
    expect(result).toContain("[#2]");
    expect(result).toContain("[BIAS]");
    expect(result).toContain("[RULE-GAP]");
  });
});
