// ============================================================
// NEXUS — RSS News Feed Module
// Fetches headlines from configurable RSS/Atom feeds
// ============================================================

import * as fs from "fs";
import * as path from "path";
import { sanitizeMacroText, sanitizeErrorMessage } from "./macro";

// ── Types ────────────────────────────────────────────────────

export interface RSSFeedConfig {
  url:      string;
  name:     string;
  category: string;
}

export interface RSSArticle {
  title:     string;
  source:    string;
  category:  string;
  published: string;
  link:      string;
}

export interface RSSSnapshot {
  timestamp: Date;
  articles:  RSSArticle[];
  errors:    string[];
}

// ── Constants ────────────────────────────────────────────────

const RSS_TIMEOUT       = 10000;   // 10s per feed
const MAX_ARTICLES      = 30;      // total across all feeds
const MAX_PER_FEED      = 5;       // headlines per feed
const MAX_TITLE_CHARS   = 200;     // per article title
const MAX_TOTAL_CHARS   = 4000;    // total chars injected into prompt

const DEFAULT_FEEDS: RSSFeedConfig[] = [
  { url: "https://feeds.reuters.com/reuters/businessNews", name: "Reuters Business", category: "markets" },
  { url: "https://feeds.bbci.co.uk/news/business/rss.xml", name: "BBC Business", category: "markets" },
  { url: "https://www.coindesk.com/arc/outboundfeeds/rss/", name: "CoinDesk", category: "crypto" },
];

// ── Config Loading ───────────────────────────────────────────

function loadFeedConfigs(): RSSFeedConfig[] {
  try {
    const configPath = path.join(process.cwd(), "config", "rss-feeds.json");
    if (fs.existsSync(configPath)) {
      const feeds: RSSFeedConfig[] = JSON.parse(fs.readFileSync(configPath, "utf-8"));
      if (feeds.length > 0) return feeds;
    }
  } catch {
    // fall through to defaults
  }
  return DEFAULT_FEEDS;
}

export const RSS_FEEDS: RSSFeedConfig[] = loadFeedConfigs();

// ── XML Parsing (lightweight, no dependencies) ───────────────

function extractTag(xml: string, tag: string): string {
  const regex = new RegExp(`<${tag}[^>]*>(?:<!\\[CDATA\\[)?([\\s\\S]*?)(?:\\]\\]>)?<\\/${tag}>`, "i");
  const match = xml.match(regex);
  return match ? match[1].trim() : "";
}

function parseRSSItems(xml: string): Array<{ title: string; link: string; pubDate: string }> {
  const items: Array<{ title: string; link: string; pubDate: string }> = [];

  // Try RSS 2.0 <item> tags
  const rssItemRegex = /<item[\s>]([\s\S]*?)<\/item>/gi;
  let match;
  while ((match = rssItemRegex.exec(xml)) !== null) {
    const itemXml = match[1];
    items.push({
      title:   extractTag(itemXml, "title"),
      link:    extractTag(itemXml, "link"),
      pubDate: extractTag(itemXml, "pubDate") || extractTag(itemXml, "dc:date"),
    });
  }

  // Try Atom <entry> tags if no RSS items found
  if (items.length === 0) {
    const atomEntryRegex = /<entry[\s>]([\s\S]*?)<\/entry>/gi;
    while ((match = atomEntryRegex.exec(xml)) !== null) {
      const entryXml = match[1];
      const linkMatch = entryXml.match(/<link[^>]*href="([^"]*)"[^>]*\/?>/i);
      items.push({
        title:   extractTag(entryXml, "title"),
        link:    linkMatch ? linkMatch[1] : "",
        pubDate: extractTag(entryXml, "published") || extractTag(entryXml, "updated"),
      });
    }
  }

  return items;
}

// ── Feed Fetching ────────────────────────────────────────────

async function fetchSingleFeed(feed: RSSFeedConfig): Promise<RSSArticle[]> {
  const res = await fetch(feed.url, {
    headers: {
      "User-Agent": "NEXUS-Agent/1.0",
      "Accept":     "application/rss+xml, application/xml, text/xml, application/atom+xml",
    },
    signal: AbortSignal.timeout(RSS_TIMEOUT),
  });

  if (!res.ok) {
    throw new Error(`HTTP ${res.status} from ${feed.name}`);
  }

  const xml = await res.text();
  const items = parseRSSItems(xml);

  return items.slice(0, MAX_PER_FEED).map((item) => ({
    title:     sanitizeMacroText(item.title.slice(0, MAX_TITLE_CHARS)),
    source:    feed.name,
    category:  feed.category,
    published: item.pubDate,
    link:      item.link,
  })).filter((a) => a.title && a.title !== "[REMOVED]");
}

// ── Main Fetch Function ──────────────────────────────────────

export async function fetchRSSNews(): Promise<RSSSnapshot> {
  const feeds = RSS_FEEDS;
  const errors: string[] = [];
  let allArticles: RSSArticle[] = [];

  const results = await Promise.allSettled(
    feeds.map((feed) => fetchSingleFeed(feed))
  );

  for (let i = 0; i < results.length; i++) {
    const result = results[i];
    if (result.status === "fulfilled") {
      allArticles.push(...result.value);
    } else {
      errors.push(sanitizeErrorMessage(`RSS ${feeds[i].name}: ${result.reason?.message ?? result.reason}`));
    }
  }

  // Deduplicate by normalized title (first 60 chars lowercase)
  const seen = new Set<string>();
  allArticles = allArticles.filter((a) => {
    const key = a.title.toLowerCase().slice(0, 60);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  // Cap total articles
  allArticles = allArticles.slice(0, MAX_ARTICLES);

  return {
    timestamp: new Date(),
    articles:  allArticles,
    errors,
  };
}

// ── Prompt Formatting ────────────────────────────────────────

export function formatRSSForPrompt(snapshot: RSSSnapshot): string {
  if (snapshot.articles.length === 0) return "";

  const lines: string[] = ["--- RSS NEWS HEADLINES ---"];
  let totalChars = 0;

  // Group by category
  const byCategory = new Map<string, RSSArticle[]>();
  for (const article of snapshot.articles) {
    const cat = article.category;
    if (!byCategory.has(cat)) byCategory.set(cat, []);
    byCategory.get(cat)!.push(article);
  }

  for (const [category, articles] of byCategory) {
    lines.push(`\n[${category.toUpperCase()}]`);
    for (const a of articles) {
      const line = `- ${a.title} (${a.source})`;
      if (totalChars + line.length > MAX_TOTAL_CHARS) break;
      lines.push(line);
      totalChars += line.length;
    }
    if (totalChars >= MAX_TOTAL_CHARS) break;
  }

  const successCount = snapshot.articles.length;
  const errorCount   = snapshot.errors.length;
  lines.push(`\n(${successCount} headlines from ${RSS_FEEDS.length - errorCount}/${RSS_FEEDS.length} feeds)`);

  return lines.join("\n");
}
