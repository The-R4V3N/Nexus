import { describe, it, expect } from "vitest";
import { sanitizeUnicode } from "../src/issues";

// ── sanitizeUnicode ─────────────────────────────────────────

describe("sanitizeUnicode", () => {
  it("passes normal ASCII text through", () => {
    expect(sanitizeUnicode("Hello World")).toBe("Hello World");
  });

  it("passes valid emoji through", () => {
    // Valid surrogate pairs (full emoji) should survive
    const result = sanitizeUnicode("Hello \u{1F600} World");
    expect(result).toContain("Hello");
    expect(result).toContain("World");
  });

  it("trims whitespace", () => {
    expect(sanitizeUnicode("  hello  ")).toBe("hello");
  });

  it("removes lone high surrogates", () => {
    // \uD800 without a following low surrogate
    const input = "Hello\uD800World";
    const result = sanitizeUnicode(input);
    expect(result).toBe("HelloWorld");
  });

  it("removes lone low surrogates", () => {
    // \uDC00 without a preceding high surrogate
    const input = "Hello\uDC00World";
    const result = sanitizeUnicode(input);
    expect(result).toBe("HelloWorld");
  });

  it("handles empty string", () => {
    expect(sanitizeUnicode("")).toBe("");
  });

  it("handles string with only whitespace", () => {
    expect(sanitizeUnicode("   ")).toBe("");
  });
});
