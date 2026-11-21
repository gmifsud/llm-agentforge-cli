# llm-agentforge-cli — AGENTS.md

> Generic agent runner contract. Auto-discovered by Codex CLI, Cursor, Kilo, and other AGENTS.md-aware tools.
> Index, not data dump. Keep <200 lines.

## Project
- **Name:** llm-agentforge-cli
- **Stack:** Node.js 22+ CommonJS with no runtime dependencies (CLI and dashboard server); Angular 22 + TypeScript for the dashboard UI (Node 24.15+)
- **Owner:** grego
- **Repo root:** `D:\Repos\LLM\llm-agentforge-cli`
- **Bootstrapped:** 2026-11-11 via `agentforge`

## Operating Principles

### 95% Confidence Rule
1. Read the actual files involved — do not assume content.
2. Trace the full call chain from entry point to effect.
3. If confidence <95%, state what's missing and ask. Never guess.

### Determinism
Reproducibility across environments is required. Flag non-determinism explicitly.

### Surgical Changes
Target the specific file/function causing the issue. No cascading defensive refactors.

## Build & Run
```bash
npm test                     # core tests (node:test); no install needed
npm --prefix dashboard/web ci   # dashboard dependencies (Node 24.15+)
npm run dashboard:test       # dashboard unit tests (vitest)
npm run dashboard:build      # Angular build into dashboard/web/dist
node src/cli/main.js help    # the CLI
npm run dashboard:start      # dashboard; open http://127.0.0.1:<port>, not localhost
```

## Conventions
- British English where natural.
- No committed build artifacts; no magic strings without constants.
- Review format: **Verdict → Location → Issue → Impact → Remediation → Verification**.

## Skills
Skill library symlinked at `.agents/skills/` (or `.codex/skills/` depending on target). Reference specific skills; do not bulk-load.

## Token Hygiene
- Batch instructions in a single prompt where possible.
- Use surgical file references (`@path/file.ts`), never "search the repo".
- Limit shell output (`head`, `--oneline`, `-n N`).
- Prefer cheaper models for sub-agents and formatting tasks.

## Lessons Learned
<!-- One-line bullets, <15 words, prune weekly -->
- _(empty)_

## Decisions Log
<!-- Stable architectural decisions. Link ADRs where they exist. -->
- _(empty)_
