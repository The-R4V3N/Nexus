import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { JournalEntry, OracleAnalysis, AxiomReflection } from "../src/types";

// ── Test Helpers ─────────────────────────────────────────────

function makeEntry(overrides: Partial<JournalEntry> = {}): JournalEntry {
  return {
    sessionNumber: 70,
    date: "2026-03-22 10:16",
    title: "WEEKEND ↕ Bitcoin PDL + no rule changes",
    oracleSummary: "Weekend crypto session showing defensive positioning",
    axiomSummary: "Screening gap identified",
    fullAnalysis: {
      timestamp: new Date(),
      sessionId: "test-session",
      marketSnapshots: [],
      analysis: "Test analysis",
      setups: [
        {
          instrument: "Bitcoin",
          type: "PDL",
          direction: "bullish",
          description: "BTC holding above support",
          invalidation: "Break below 69000",
          entry: 69200,
          stop: 68800,
          target: 70500,
          RR: 3.25,
          timeframe: "4H",
        },
        {
          instrument: "Ethereum",
          type: "PDL",
          direction: "bullish",
          description: "ETH holding above support",
          invalidation: "Break below 2820",
          entry: 2850,
          stop: 2820,
          target: 2920,
          RR: 2.33,
          timeframe: "4H",
        },
      ],
      bias: { overall: "mixed", notes: "Limited weekend data" },
      keyLevels: [
        { instrument: "Bitcoin", level: 69200, type: "support", notes: "Psychological level" },
        { instrument: "Bitcoin", level: 70500, type: "resistance", notes: "Swing high" },
      ],
      confidence: 47,
    } as OracleAnalysis,
    reflection: {
      whatWorked: "Good analysis",
      whatFailed: "Screening gap",
      cognitiveBiases: ["availability bias"],
      evolutionSummary: "Weekend screening needs improvement",
      ruleUpdates: [],
      newRules: [],
      newSystemPromptSections: "",
      newSelfTasks: [],
      resolvedSelfTasks: [],
    } as unknown as AxiomReflection,
    ruleCount: 29,
    systemPromptVersion: 50,
    ...overrides,
  };
}

// ── Tests ────────────────────────────────────────────────────

describe("isNotificationEnabled", () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
    delete process.env.TELEGRAM_BOT_TOKEN;
    delete process.env.TELEGRAM_CHAT_ID;
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it("returns false when both env vars are missing", async () => {
    const { isNotificationEnabled } = await import("../src/notifications");
    expect(isNotificationEnabled()).toBe(false);
  });

  it("returns false when only token is set", async () => {
    process.env.TELEGRAM_BOT_TOKEN = "123:ABC";
    const { isNotificationEnabled } = await import("../src/notifications");
    expect(isNotificationEnabled()).toBe(false);
  });

  it("returns false when only chat ID is set", async () => {
    process.env.TELEGRAM_CHAT_ID = "12345";
    const { isNotificationEnabled } = await import("../src/notifications");
    expect(isNotificationEnabled()).toBe(false);
  });

  it("returns true when both vars are set", async () => {
    process.env.TELEGRAM_BOT_TOKEN = "123:ABC";
    process.env.TELEGRAM_CHAT_ID = "12345";
    const { isNotificationEnabled } = await import("../src/notifications");
    expect(isNotificationEnabled()).toBe(true);
  });
});

describe("formatSessionMessage", () => {
  it("includes session number, bias, confidence, and rule count", async () => {
    const { formatSessionMessage } = await import("../src/notifications");
    const msg = formatSessionMessage(makeEntry());
    expect(msg).toContain("#70");
    expect(msg).toContain("MIXED");
    expect(msg).toContain("47%");
    expect(msg).toContain("29");
  });

  it("includes setup details with entry, stoploss, and target", async () => {
    const { formatSessionMessage } = await import("../src/notifications");
    const msg = formatSessionMessage(makeEntry());
    expect(msg).toContain("Bitcoin");
    expect(msg).toContain("69200");
    expect(msg).toContain("68800");
    expect(msg).toContain("70500");
    expect(msg).toContain("Ethereum");
    expect(msg).toContain("2850");
    expect(msg).toContain("2820");
    expect(msg).toContain("2920");
  });

  it("includes evolution summary", async () => {
    const { formatSessionMessage } = await import("../src/notifications");
    const msg = formatSessionMessage(makeEntry());
    expect(msg).toContain("Weekend screening needs improvement");
  });

  it("includes journal link", async () => {
    const { formatSessionMessage } = await import("../src/notifications");
    const msg = formatSessionMessage(makeEntry());
    expect(msg).toContain("https://the-r4v3n.github.io/Nexus/");
  });

  it("handles zero setups gracefully", async () => {
    const { formatSessionMessage } = await import("../src/notifications");
    const entry = makeEntry({
      fullAnalysis: {
        ...makeEntry().fullAnalysis,
        setups: [],
      } as OracleAnalysis,
    });
    const msg = formatSessionMessage(entry);
    expect(msg).toContain("0");
    expect(msg).not.toContain("undefined");
  });
});

describe("sendTelegramMessage", () => {
  beforeEach(() => {
    process.env.TELEGRAM_BOT_TOKEN = "123:ABC";
    process.env.TELEGRAM_CHAT_ID = "12345";
  });

  afterEach(() => {
    delete process.env.TELEGRAM_BOT_TOKEN;
    delete process.env.TELEGRAM_CHAT_ID;
    vi.restoreAllMocks();
  });

  it("calls correct Telegram API URL with right payload", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ ok: true }),
    });
    vi.stubGlobal("fetch", mockFetch);

    const { sendTelegramMessage } = await import("../src/notifications");
    await sendTelegramMessage("Test message");

    expect(mockFetch).toHaveBeenCalledOnce();
    const [url, options] = mockFetch.mock.calls[0];
    expect(url).toBe("https://api.telegram.org/bot123:ABC/sendMessage");
    const body = JSON.parse(options.body);
    expect(body.chat_id).toBe("12345");
    expect(body.text).toBe("Test message");
    expect(body.parse_mode).toBe("Markdown");
  });

  it("returns false on API failure without throwing", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 401,
      text: () => Promise.resolve("Unauthorized"),
    });
    vi.stubGlobal("fetch", mockFetch);

    const { sendTelegramMessage } = await import("../src/notifications");
    const result = await sendTelegramMessage("Test");
    expect(result).toBe(false);
  });
});

describe("notifySessionComplete", () => {
  afterEach(() => {
    delete process.env.TELEGRAM_BOT_TOKEN;
    delete process.env.TELEGRAM_CHAT_ID;
    vi.restoreAllMocks();
  });

  it("skips silently when notifications are disabled", async () => {
    const mockFetch = vi.fn();
    vi.stubGlobal("fetch", mockFetch);

    const { notifySessionComplete } = await import("../src/notifications");
    await notifySessionComplete(makeEntry());
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("sends message when enabled", async () => {
    process.env.TELEGRAM_BOT_TOKEN = "123:ABC";
    process.env.TELEGRAM_CHAT_ID = "12345";
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ ok: true }),
    });
    vi.stubGlobal("fetch", mockFetch);

    const { notifySessionComplete } = await import("../src/notifications");
    await notifySessionComplete(makeEntry());
    expect(mockFetch).toHaveBeenCalledOnce();
  });
});
