# Security Policy

## NEXUS Security Model

NEXUS accepts external input through GitHub Issues, which is an inherent attack surface. The system is designed with defense-in-depth to prevent prompt injection, cost abuse, and memory manipulation.

### Current Protections

- **Prompt injection detection** — 20+ regex patterns scan all issue titles and bodies before they reach the AI
- **Cost abuse limits** — hard caps on issues per session (5), total chars (4,000), ORACLE output tokens (8,192), AXIOM/FORGE tokens (4,096), rules per session (2), FORGE patches per session (2, max 200 lines each)
- **Memory integrity** — AXIOM's output is sanitized before writing to `memory/`. Rule weights clamped to 1-10, categories validated against allowlists, resolvedSelfTasks comments HTML-stripped and capped
- **Foundational rule protection** — rules r001-r010 cannot be deleted, minimum 5 rules enforced
- **System prompt cap** — 8,000 character limit prevents unbounded growth
- **FORGE content safety** — `isCodeSafe()` scans AI-generated code for dangerous patterns (secret exfiltration, child_process, exec, eval, filesystem mutations) before writing to disk
- **FORGE file protection** — protected files (`security.ts`, `forge.ts`, `session.yml`, `README.md`) and protected prefixes (`security-*`, `forge-*`) cannot be created or modified by FORGE
- **Macro data sanitization** — GDELT article titles and Alpha Vantage ticker data are sanitized against injection patterns before entering the AI prompt
- **Error log safety** — API keys are stripped from error messages before logging to prevent exposure in CI output
- **Fetch timeouts** — all external API calls have `AbortSignal.timeout()` to prevent session hangs

### Supported Versions

| Version | Supported |
| ------- | --------- |
| latest (main) | Yes |

### Reporting a Vulnerability

If you discover a security vulnerability — especially a way to bypass the prompt injection filter or manipulate NEXUS's memory through crafted input — please report it responsibly.

**Do NOT open a public issue for security vulnerabilities.**

Instead, please use one of the following:

1. **GitHub Security Advisories** — go to the [Security tab](https://github.com/The-R4V3N/Nexus/security/advisories) and create a private advisory
2. **Email** — reach out directly at <nichdefisch@gmail.com>

### What Counts as a Vulnerability

- Bypassing the prompt injection filter in `security.ts`
- Manipulating NEXUS's rules or system prompt through crafted issue content
- Causing NEXUS to exceed cost limits (token, issue, or rule caps)
- Getting NEXUS to leak its API key or system prompt
- XSS or injection through the GitHub Pages journal site
- Any way to make NEXUS delete its foundational rules

### What Does NOT Count

- NEXUS making a bad market analysis — that's a feature request, not a security issue
- NEXUS ignoring your suggestion — that's by design
- Disagreeing with NEXUS's confidence score — open a feedback issue instead

### Response

Security reports will be acknowledged within 48 hours. Confirmed vulnerabilities will be patched and credited (unless you prefer anonymity).
