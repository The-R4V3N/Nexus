// ============================================================
// NEXUS — Telegram Notification Module
// Sends session summaries via Telegram Bot API (raw fetch)
// ============================================================

import type { JournalEntry } from "./types";

// ── Config ───────────────────────────────────────────────────

const TELEGRAM_TIMEOUT = 10000; // 10s
const JOURNAL_URL      = "https://the-r4v3n.github.io/Nexus/";

// ── Enabled Check ────────────────────────────────────────────

export function isNotificationEnabled(): boolean {
  return !!(process.env.TELEGRAM_BOT_TOKEN && process.env.TELEGRAM_CHAT_ID);
}

// ── Message Formatting ───────────────────────────────────────

const BIAS_EMOJI: Record<string, string> = {
  bullish: "🟢",
  bearish: "🔴",
  mixed:   "🟡",
  neutral: "⚪",
};

export function formatSessionMessage(entry: JournalEntry): string {
  const bias  = entry.fullAnalysis.bias.overall;
  const emoji = BIAS_EMOJI[bias] ?? "⚪";
  const setups = entry.fullAnalysis.setups;

  const lines: string[] = [
    `🔮 *NEXUS Session #${entry.sessionNumber} Complete*`,
    "",
    `${emoji} *Bias:* ${bias.toUpperCase()} | *Confidence:* ${entry.fullAnalysis.confidence}%`,
    `📈 *Setups:* ${setups.length} | *Rules:* ${entry.ruleCount} (v${entry.systemPromptVersion})`,
  ];

  if (setups.length > 0) {
    lines.push("", "🎯 *Setups:*");
    for (const s of setups) {
      const dir = s.direction === "bullish" ? "↑" : s.direction === "bearish" ? "↓" : "↔";
      let detail = `• *${s.instrument}* — ${s.type} ${dir}`;
      if (s.entry != null) detail += `\n  Entry: ${s.entry}`;
      if (s.stop != null)  detail += ` | SL: ${s.stop}`;
      if (s.target != null) detail += ` | TP: ${s.target}`;
      if (s.RR != null) detail += ` | RR: ${s.RR}`;
      lines.push(detail);
    }
  }

  if (entry.reflection.evolutionSummary) {
    lines.push("", `🧠 *Evolution:* ${entry.reflection.evolutionSummary}`);
  }

  lines.push("", `📖 [Live Journal](${JOURNAL_URL})`);

  return lines.join("\n");
}

// ── Telegram API ─────────────────────────────────────────────

export async function sendTelegramMessage(text: string): Promise<boolean> {
  const token  = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;

  if (!token || !chatId) return false;

  try {
    const url = `https://api.telegram.org/bot${token}/sendMessage`;
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id:    chatId,
        text,
        parse_mode: "Markdown",
      }),
      signal: AbortSignal.timeout(TELEGRAM_TIMEOUT),
    });

    if (!res.ok) {
      const body = await res.text();
      console.warn(`  ⚠ Telegram API error (${res.status}): ${body.slice(0, 200)}`);
      return false;
    }

    return true;
  } catch (err: any) {
    console.warn(`  ⚠ Telegram notification failed: ${err.message}`);
    return false;
  }
}

// ── Orchestrator ─────────────────────────────────────────────

export async function notifySessionComplete(entry: JournalEntry): Promise<void> {
  if (!isNotificationEnabled()) return;

  const message = formatSessionMessage(entry);
  const sent = await sendTelegramMessage(message);

  if (sent) {
    console.log("  ✓ Telegram notification sent");
  }
}
