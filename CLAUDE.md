# llm-agentforge-cli

> **Index, not data dump.** Point Claude at the right files; don't paraphrase them here.
> Auto-loaded every turn — keep this file <200 lines.

## 1. Project Snapshot
- **Name:** llm-agentforge-cli
- **Stack:** Node.js 22+ CommonJS with no runtime dependencies (CLI and dashboard server); Angular 22 + TypeScript for the dashboard UI (Node 24.15+)
- **Owner:** grego
- **Repo root:** `D:\Repos\LLM\llm-agentforge-cli`
- **Bootstrapped:** 2026-11-11 via `agentforge`

## 2. Non-Negotiables

### 95% Confidence Rule
Before modifying ANY code or suggesting changes:
1. Read the actual files involved — do not assume content.
2. Trace the full call chain from entry point to effect.
3. If confidence is below 95%, state what's missing and ask. Never guess.

Be surgical: target the specific file/function/chain causing the issue. No cascading defensive changes.

### Determinism
If it can't be reproduced reliably across environments, it's broken. Flag non-determinism explicitly.

### Isolation Boundaries
Tenant logic, module boundaries, plugin scopes — any change crossing a boundary gets extra scrutiny and explicit justification.

## 3. Map (where things live)
- **Entry points:** `@src/cli/main.js` (CLI) · `@dashboard/server/main.js` (dashboard server)
- **Core layers:** `@src/domain/` (rules, errors) · `@src/application/` (use cases) · `@src/deployment/` (plan, then apply; `apply.js` is the only code that writes into a project) · `@src/infra/` (fs, git, paths) · `@src/discovery/` (skill scan, lint, listing budget)
- **Dashboard:** `@dashboard/server/` (HTTP, read and write workers) · `@dashboard/web/` (Angular UI) · `@dashboard/contracts.d.ts` (API shapes)
- **Machine state:** `~/.agentforge/` (repos.json, config.json, merged-skills/, views/)
- **Templates:** `@templates/`
- **Tests:** `@tests/` (node:test) · `@dashboard/web/src/app/*.spec.ts` (vitest) · `@dashboard/web/e2e/` (Playwright)
- **Build/CI:** `@.github/workflows/ci.yml`
- **Docs:** `@README.md` · `@docs/USER-GUIDE.md` · `@docs/DASHBOARD.md`

## 4. Build & Run
```bash
npm test                     # core tests (node:test); no install needed
npm --prefix dashboard/web ci   # dashboard dependencies (Node 24.15+)
npm run dashboard:test       # dashboard unit tests (vitest)
npm run dashboard:build      # Angular build into dashboard/web/dist
node src/cli/main.js help    # the CLI
npm run dashboard:start      # dashboard; open http://127.0.0.1:<port>, not localhost
```

## 5. Conventions
- British English in prose and identifiers where natural (favour, behaviour, analyse).
- No committed build artifacts. No fragile path aliases. No magic strings without constants.
- Code review format: **Verdict → Location → Issue → Impact → Remediation → Verification**.

## 6. Skills
Skill library is junction-linked at `.claude/skills/` → vault root. Reference a specific skill when invoking it; do not bulk-load.

## 7. Token Hygiene (operational)
- Use `/clear` when switching unrelated tasks.
- Disconnect MCP servers not needed for the current task (~18k tokens each).
- Batch prompts; edit + regenerate instead of follow-up corrections.
- Use Plan Mode for non-trivial work.
- Run `/context` and `/cost` periodically.
- Compact at ~60% context, not auto-trigger at 95%.
- Run `/compact` or `/clear` before breaks >5 min (prompt cache timeout).
- Surgical file refs (`@path/to/file.ts:fn`), never "search the repo".
- Limit shell output: `head`, `tail`, `--oneline`, `-n`. Deny heavy commands in permissions.
- Sonnet by default. Haiku for sub-agents and formatting. Opus only for deep architecture (<20% usage).

## 8. Lessons Learned
<!--
When something fails repeatedly, when I have to re-explain, or when a workaround is found
for a platform, tool, or limitation, add a one-line bullet here.
Keep each bullet under 15 words. No explanations. Only add things that will save time in future sessions.
Review weekly — prune anything stale.
-->
- _(empty — populate as patterns emerge)_

## 9. Decisions Log
<!-- Stable architectural decisions. One line each. Link to ADR if it deserves more. -->
- _(empty)_
