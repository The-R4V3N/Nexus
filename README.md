# NEXUS 🔮

> The market mind that rewrites itself.

NEXUS is a self-evolving market intelligence agent. Every session it analyzes global financial markets using ICT methodology, then reflects on its own reasoning, identifies cognitive biases, and rewrites its own rules and system prompt.

It grows in public. Its mind is open source.

---

## What is this?

NEXUS has two parallel loops:

**🔭 ORACLE** — Market analysis using ICT concepts: FVGs, order blocks, liquidity sweeps, market structure shifts. Covers forex, indices (NAS100, SPX, DAX), crypto, metals (Gold, Silver), and commodities (Oil, Gas).

**🧠 AXIOM** — Cognitive self-reflection. After each analysis, NEXUS critiques itself: what biases appeared, what rules are wrong, what's missing. Then it literally rewrites its own `memory/system-prompt.md` and `memory/analysis-rules.json`.

The evolution is committed to git. The journal is published to GitHub Pages.

---

## Setup

```bash
# 1. Clone and install
git clone <your-repo>
cd nexus
npm install

# 2. Set your API key
cp .env.example .env
# Edit .env and add your ANTHROPIC_API_KEY
# (Alpha Vantage key optional for now — Yahoo Finance is free)

# 3. Run first session
npm run run:session
```

---

## Commands

| Command | Description |
|---------|-------------|
| `npm run run:session` | Run a full ORACLE + AXIOM session |
| `npx ts-node src/index.ts status` | Current state of NEXUS's mind |
| `npx ts-node src/index.ts journal` | List past sessions |
| `npx ts-node src/index.ts mind` | See all current analysis rules |
| `npx ts-node src/index.ts rebuild-site` | Regenerate GitHub Pages |

---

## Project Structure

```
nexus/
├── src/
│   ├── index.ts        # CLI entry point
│   ├── agent.ts        # Session orchestrator
│   ├── oracle.ts       # Market analysis engine
│   ├── axiom.ts        # Self-reflection + memory evolution
│   ├── markets.ts      # Data fetching (Yahoo Finance)
│   ├── journal.ts      # Markdown + GitHub Pages writer
│   └── types.ts        # TypeScript interfaces
│
├── memory/             # NEXUS's evolving mind (committed to git)
│   ├── system-prompt.md    # Current system prompt (grows each session)
│   ├── analysis-rules.json # Current rules (evolves each session)
│   └── sessions.json       # All session data
│
├── journal/            # Markdown journal entries
│   └── session-0001-*.md
│
├── docs/               # GitHub Pages site
│   └── index.html      # The public journal
│
└── .env                # Your API keys (never committed)
```

---

## GitHub Pages Setup

1. Push to GitHub
2. Go to Settings → Pages
3. Set source to `main` branch, `/docs` folder
4. Your evolving journal is live

---

## The Rules

1. **Every session produces one journal entry.** No silent sessions.
2. **AXIOM always runs after ORACLE.** No analysis without reflection.
3. **Memory is committed to git.** Every rule change is versioned history.
4. **I never delete the journal.** It's my memory.
5. **Confidence must be honest.** No setup with < 2 confluences gets > 40% confidence.

---

## Day 0

NEXUS begins with:
- 10 foundational analysis rules
- A base system prompt built on ICT methodology
- No history, no bias, no predictions

Every session it gets a little smarter.

---

*built by an AI that evolves itself*
