import { describe, it, expect } from "vitest";
import { salvageJSON, stripSurrogates, extractJSONFromResponse, groupBy } from "../src/utils";

// ── salvageJSON ──────────────────────────────────────────────

describe("salvageJSON", () => {
  it("parses valid JSON as-is", () => {
    const result = salvageJSON('{"key": "value"}');
    expect(result).toEqual({ key: "value" });
  });

  it("returns null for completely invalid JSON", () => {
    expect(salvageJSON("not json at all")).toBeNull();
  });

  it("closes unclosed braces", () => {
    const result = salvageJSON('{"key": "value"');
    expect(result).toEqual({ key: "value" });
  });

  it("closes unclosed brackets", () => {
    const result = salvageJSON('{"items": [1, 2, 3');
    expect(result).toEqual({ items: [1, 2, 3] });
  });

  it("removes trailing commas before closing", () => {
    const result = salvageJSON('{"a": 1, "b": 2,');
    expect(result).toEqual({ a: 1, b: 2 });
  });

  it("handles dangling string (truncated mid-value)", () => {
    // String truncated mid-value with trailing comma
    const result = salvageJSON('{"a": "hello", "b": "worl');
    // Should close dangling string and braces
    expect(result).not.toBeNull();
    if (result) {
      expect(result.a).toBe("hello");
    }
  });

  it("handles nested structures with missing closers", () => {
    const result = salvageJSON('{"a": {"b": [1, 2]');
    expect(result).toEqual({ a: { b: [1, 2] } });
  });

  it("returns null for empty string", () => {
    expect(salvageJSON("")).toBeNull();
  });
});

// ── stripSurrogates ──────────────────────────────────────────

describe("stripSurrogates", () => {
  it("passes normal ASCII text through", () => {
    expect(stripSurrogates("Hello World")).toBe("Hello World");
  });

  it("preserves valid emoji (surrogate pairs)", () => {
    const result = stripSurrogates("Hello \u{1F600} World");
    expect(result).toContain("Hello");
    expect(result).toContain("World");
    // The emoji should survive as a valid surrogate pair
    expect(result.length).toBeGreaterThan("Hello  World".length);
  });

  it("removes lone high surrogates", () => {
    const input = "Hello\uD800World";
    expect(stripSurrogates(input)).toBe("HelloWorld");
  });

  it("removes lone low surrogates", () => {
    const input = "Hello\uDC00World";
    expect(stripSurrogates(input)).toBe("HelloWorld");
  });

  it("handles empty string", () => {
    expect(stripSurrogates("")).toBe("");
  });

  it("handles string with only surrogates", () => {
    expect(stripSurrogates("\uD800\uD801")).toBe("");
  });
});

// ── extractJSONFromResponse ──────────────────────────────────

describe("extractJSONFromResponse", () => {
  it("returns clean JSON unchanged", () => {
    const json = '{"key": "value"}';
    expect(extractJSONFromResponse(json)).toBe(json);
  });

  it("strips markdown code fences", () => {
    const input = '```json\n{"key": "value"}\n```';
    expect(extractJSONFromResponse(input)).toBe('{"key": "value"}');
  });

  it("extracts JSON from surrounding text", () => {
    const input = 'Here is my analysis:\n{"key": "value"}\nEnd of response.';
    expect(extractJSONFromResponse(input)).toBe('{"key": "value"}');
  });

  it("handles JSON with no surrounding text", () => {
    const input = '{"a": 1, "b": [2, 3]}';
    expect(extractJSONFromResponse(input)).toBe('{"a": 1, "b": [2, 3]}');
  });

  it("handles text only before the JSON", () => {
    const input = 'Some preamble text {"key": "value"}';
    expect(extractJSONFromResponse(input)).toBe('{"key": "value"}');
  });

  it("handles text only after the JSON", () => {
    const input = '{"key": "value"} some trailing text';
    expect(extractJSONFromResponse(input)).toBe('{"key": "value"}');
  });

  it("returns original trimmed text if no braces found", () => {
    const input = "no json here";
    expect(extractJSONFromResponse(input)).toBe("no json here");
  });
});

// ── groupBy ──────────────────────────────────────────────────

describe("groupBy", () => {
  it("groups items by key function", () => {
    const items = [
      { name: "a", cat: "x" },
      { name: "b", cat: "y" },
      { name: "c", cat: "x" },
    ];
    const result = groupBy(items, (i) => i.cat);
    expect(result).toEqual({
      x: [{ name: "a", cat: "x" }, { name: "c", cat: "x" }],
      y: [{ name: "b", cat: "y" }],
    });
  });

  it("returns empty object for empty array", () => {
    expect(groupBy([], (i) => String(i))).toEqual({});
  });

  it("handles single group", () => {
    const items = [1, 2, 3];
    const result = groupBy(items, () => "all");
    expect(result).toEqual({ all: [1, 2, 3] });
  });

  it("handles each item in its own group", () => {
    const items = ["a", "b", "c"];
    const result = groupBy(items, (i) => i);
    expect(result).toEqual({ a: ["a"], b: ["b"], c: ["c"] });
  });
});
