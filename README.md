# agentforge

> Repo bootstrap for agent-driven workflows. Drop a token-optimised `CLAUDE.md` / `AGENTS.md` / `GEMINI.md` into any project and link the shared skill vault into the right dot-folder. One command. Idempotent. Refuses rather than guesses.

**New here?** Read [docs/USER-GUIDE.md](docs/USER-GUIDE.md): concepts, a first-fifteen-minutes walkthrough, everyday jobs and what every refusal means.

## Why

Every new project follows the same ritual: write a `CLAUDE.md` that respects the [token-management strategies](../llm-skill-vault/Claude_Token_Management_Strategies.md), junction `.claude/skills/` to the central vault, repeat for `.codex/`, `.agents/` or `.gemini/`. `agentforge` makes that one command, and `agentforge repo` aggregates skills from external repositories into one merged view.

## Layout

```
llm-agentforge-cli/
├── agentforge.ps1          # thin forwarder → node src/cli/main.js
├── agentforge.sh           # thin forwarder → node src/cli/main.js
├── repo.js                 # compatibility shim: `node repo.js …` == `agentforge repo …`
├── tool.manifest.json      # gd-tool-harness registration (preview / apply / risk per command)
├── src/
│   ├── cli/                # argument parsing (both spellings), output, exit codes
│   ├── application/        # use cases: sources, sync, project (init/link/doctor)
│   ├── deployment/         # plan (read-only) · apply (the only mutator) · build-view (staged swap)
│   ├── discovery/          # manifest + SKILL.md discovery with containment checks
│   ├── domain/             # target matrix, source-ID rules, errors
│   └── infra/              # paths/config, git (execFile), filesystem inspection
├── tests/                  # node --test, real temp directories
├── templates/              # CLAUDE.md.tmpl · AGENTS.md.tmpl · GEMINI.md.tmpl
└── scripts/archive-skills.ps1
```

Requires Node.js 20+. No dependencies.

## Targets

| Target    | Doc         | Dot folder  | Use case                               |
| --------- | ----------- | ----------- | -------------------------------------- |
| `claude`  | `CLAUDE.md` | `.claude/`  | Claude Code CLI (default)              |
| `codex`   | `AGENTS.md` | `.codex/`   | OpenAI Codex CLI                       |
| `generic` | `AGENTS.md` | `.agents/`  | Cursor, Kilo, anything AGENTS.md-aware |
| `gemini`  | `GEMINI.md` | `.gemini/`  | Gemini CLI                             |
| `all`     | all docs    | all four    | belt-and-braces (`AGENTS.md` written once) |

## Quick start

### Windows (PowerShell)

```powershell
# One-time wiring in $PROFILE
function agentforge { pwsh -NoProfile -File "D:\Repos\LLM\llm-agentforge-cli\agentforge.ps1" @args }

cd D:\Repos\my-new-app
agentforge init -Name my-new-app -Stack "TypeScript / Vite / .NET 8"
```

### WSL2 / Linux / macOS

```bash
echo 'alias agentforge="bash /mnt/d/Repos/LLM/llm-agentforge-cli/agentforge.sh"' >> ~/.zshrc
chmod +x /mnt/d/Repos/LLM/llm-agentforge-cli/agentforge.sh
source ~/.zshrc

cd ~/repos/my-new-app
agentforge init --name my-new-app --stack "TypeScript / Vite / .NET 8"
```

Both spellings are accepted everywhere: `-Path X -Target all -DryRun` or `--path X --target all --dry-run`.

## Commands

### `init` — full bootstrap

```powershell
agentforge init -Path D:\Repos\my-new-app -Target claude -Name my-new-app `
  -Stack "TypeScript / Vite / .NET 8" -BuildCmd "pnpm build" -TestCmd "pnpm test" -RunCmd "pnpm dev"
```

Writes the instruction doc (skipped if it exists, unless `--force`), links `<dot>/skills` to the vault, and adds `<dot>/skills` to `.gitignore`.

### `link` — create, merge or repoint the skills folder

```powershell
agentforge link -Target claude
```

What happens depends on what is already at `<dot>/skills`:

| Destination                     | Default (preserve)                         | `--force`                        | `--force --no-preserve`          |
| ------------------------------- | ------------------------------------------ | -------------------------------- | -------------------------------- |
| missing                         | create link                                | create link                      | create link                      |
| link → this vault               | nothing to do                              | nothing to do                    | nothing to do                    |
| link → another vault, or broken | **refused** (exit 3); never merged into    | remove link, relink              | remove link, relink              |
| ordinary directory              | copy in missing vault entries, keep yours  | same                             | delete directory, create link    |
| file                            | refused                                    | refused                          | refused                          |

Removing a link never touches what it points at. A plan is re-checked at apply time; if the destination changed in between, apply refuses (`STALE_PLAN`).

### `doctor` — diagnose

```powershell
agentforge doctor -Path .          # add --json for a machine-readable report
```

```
→ agentforge doctor
  Project : D:\Repos\my-new-app
  Vault   : D:\Repos\LLM\llm-skill-vault\skills (env)

✓ vault present (321 skills with SKILL.md)
  claude    doc:✓  link:✓  link
             ↳ → D:\Repos\LLM\llm-skill-vault\skills
  codex     doc:·  link:·
```

Exit code 1 when the vault is unusable or any link is broken.

### `repo` — external skill sources

```powershell
agentforge repo add D:\Repos\LLM\llm-skills-mattpocock            # local source
agentforge repo add https://github.com/x/skills.git --name x      # git source (branch optional: git picks the remote default)
agentforge repo list
agentforge repo fetch            # clone / fast-forward git sources into ~/.agentforge/repos — never touches the view
agentforge repo sync             # fetch, then rebuild ~/.agentforge/merged-skills
agentforge repo sync --no-fetch --dry-run   # show the view that would be built (collisions, counts), write nothing
agentforge repo sync --force     # external skills override vault skills on name collision
agentforge repo remove x         # unregister; deletes the cached clone only (never a local path); view is not rebuilt
```

Skill discovery prefers `.claude-plugin/plugin.json`, falling back to a `SKILL.md` scan (depth 4). Every candidate must be a directory inside the source root, after resolving links, and contain `SKILL.md`. Links inside a source are not followed. The same rule applies to the vault.

The merged view is rebuilt by staging a new directory of links and swapping it in, so a failure never leaves projects pointing at a half-built folder. If the view contains anything that is not a link, the rebuild refuses.

## Configuration

State lives in `~/.agentforge/`:

| File / dir       | Purpose                                                   |
| ---------------- | --------------------------------------------------------- |
| `repos.json`     | Source registry. Corrupt file → fail closed, never overwritten |
| `config.json`    | Optional `{ "vaultRoot": "…" }`                           |
| `repos/`         | Git clones (disposable; marker file `.agentforge-cache-root`) |
| `merged-skills/` | The generated view: one link per skill. Never a source    |

Vault root for `init` / `link` / `doctor`:

1. `--vault` / `-VaultRoot`
2. `$env:AGENTFORGE_VAULT_ROOT`
3. `config.json` → `vaultRoot`
4. `~/.agentforge/merged-skills/` — only if `repos.json` exists beside it (an orphaned view is ignored with a warning)
5. `D:\Repos\LLM\llm-skill-vault\skills` (Windows) or `~/repos/LLM/llm-skill-vault/skills` (Unix)

Primary source for `repo sync` uses the same chain minus step 4; the view itself is refused as a source.

Link type: `--link junction|symlink|copy|none|auto` (default `auto` → junction on Windows, symlink elsewhere). `none` returns before inspecting anything and never mutates.

## Exit codes

| Code | Meaning                                                         |
| ---- | --------------------------------------------------------------- |
| 0    | ok (including "nothing to do")                                  |
| 1    | failure (git, filesystem, corrupt config, unusable vault)        |
| 2    | usage (bad option, invalid source ID, unsupported URL scheme)    |
| 3    | refused: a conflict or safety boundary; **nothing was applied** |

## Safety rules the code enforces

- Git runs as executable + argument array (`execFile`), never a shell string; clone disables hooks and submodules; URL schemes are restricted to `https://`, `ssh://`, `git@host:`.
- Source IDs are `[a-z0-9][a-z0-9_.-]{0,63}`; a cached clone is deleted only if it is an ordinary directory inside the marked cache root.
- Planning is read-only; `apply` is the only mutator and re-validates every precondition.
- `--dry-run` performs no writes, clones or config changes.
- `.gitignore` gets only the generated `<dot>/skills` entry, not the instruction doc and not the whole dot-folder.

## gd-tool-harness

`tool.manifest.json` registers each command with the harness at the right risk level (`af-doctor` ReadOnly … `af-link-repoint` Destructive) so you get preview-then-apply, approval pins and the ledger for free:

```powershell
gdt -Run af-source-fetch -Apply
gdt -Run af-view-build                 # preview (sync --no-fetch --dry-run)
gdt -Run af-init -Apply -- --path D:\Repos\my-new-app --target claude
```

The harness only scans siblings of `D:\Repos\Tools`; add this repo via a junction there or a `manifestRoots` entry in `config.global.json`.

## Testing

```bash
npm test        # node --test tests/**/*.test.js — 34 tests, all on real temp directories
```

Covers the design note's safety table: link removal leaves targets intact, user-owned skills preserved, manifest traversal and symlink escapes rejected, stale plans refused, drift reported, collisions explicit, dry run writes nothing, `none` never mutates, corrupt registry fails closed, removal never deletes a local source.

## Extending

Add a target: drop a template at `templates/<NAME>.tmpl` and add one row to `TARGETS` in `src/domain/targets.js`.

## Troubleshooting

| Symptom                                   | Cause                                              | Fix                                                        |
| ----------------------------------------- | -------------------------------------------------- | ---------------------------------------------------------- |
| `failed to create symlink` on Windows     | No admin / Dev Mode                                | Use `--link junction` (default)                             |
| `vault root does not exist`               | Env var unset and default path missing             | Set `AGENTFORGE_VAULT_ROOT` or pass `--vault`               |
| `link to another source … rerun with --force` | `<dot>/skills` points at a different vault     | `agentforge link --force` repoints it; nothing is merged    |
| `ignoring … orphaned view`                | `merged-skills` exists but `repos.json` does not   | `agentforge repo sync`, or delete the view                 |
| `… is not a link; the view must contain only links` | Something was copied into `merged-skills`| Move it out, then `repo sync --no-fetch`                    |
| Skills missing in WSL2                    | Different filesystem mount                         | Pass `--vault /mnt/d/Repos/LLM/llm-skill-vault/skills`      |

## Naming history

Considered: `agentkit`, `prab`, `claudeforge`, `vault-init`, `agentboot`. Settled on **agentforge** — neutral across agents, evokes scaffolding, no NPM clash.
