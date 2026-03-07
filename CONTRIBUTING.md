# Contributing to NEXUS

NEXUS is a self-evolving AI — it rewrites its own rules every session. You can influence its evolution through community input, code contributions, or both.

## Ways to Contribute

### 1. Challenge NEXUS's Analysis

Open an issue using the **Challenge** template. Give NEXUS a specific market scenario or instrument to analyze. This is how NEXUS learns to handle edge cases.

### 2. Give Feedback on Sessions

If NEXUS got something wrong — a bad bias call, a missed setup, a wrong confidence score — open an issue using the **Market Feedback** template. Be specific: which session, which instrument, what actually happened.

### 3. Suggest New Concepts

Want NEXUS to learn a new ICT concept, watch a new instrument, or consider a new correlation? Use the **Suggestion** template. NEXUS reads all suggestions but decides for itself what to adopt.

### 4. Code Contributions

#### Getting Started

```bash
git clone https://github.com/The-R4V3N/Nexus
cd Nexus
npm install
cp .env.example .env
# Add your ANTHROPIC_API_KEY to .env
```

#### Development

```bash
npm run run:session -- --force  # Run a session (even on weekends)
npm run status                  # Check current state
npm run mind                    # See current rules
npm run journal                 # List past sessions
```

#### Pull Request Guidelines

- **One concern per PR** — keep changes focused
- **Don't modify `memory/`** — these files are managed by NEXUS itself
- **Don't weaken security** — never relax patterns in `security.ts`
- **Foundational rules are sacred** — r001-r010 cannot be removed
- **Test before submitting** — run `npx tsc --noEmit` to verify types
- **Describe what and why** — use the PR template

#### What Makes a Good PR

- Bug fixes in the pipeline (market data fetching, JSON parsing, journal generation)
- New instruments or data sources
- Security improvements (new injection patterns, better sanitization)
- UI/UX improvements to the GitHub Pages journal site
- Documentation improvements

#### What Will Be Rejected

- Changes that bypass security checks
- Modifications to `memory/` files (NEXUS manages its own mind)
- Removal of foundational rules (r001-r010)
- Changes that break the ORACLE -> AXIOM -> Journal pipeline order

## How NEXUS Processes Community Input

1. Issues labeled `nexus-input` are fetched at the start of each session
2. All issue content passes through prompt injection detection (20+ patterns)
3. Safe issues are injected into the ORACLE and AXIOM prompts
4. NEXUS reads them, considers them, and decides what to act on
5. If NEXUS identifies a gap too big for one session, it opens a self-task issue

NEXUS considers community input but is not obligated to follow it. That's by design — it's a self-evolving system, not a command-following one.

## Code of Conduct

This project follows the [Contributor Covenant Code of Conduct](CODE_OF_CONDUCT.md). Be respectful, constructive, and focused on making NEXUS smarter.
