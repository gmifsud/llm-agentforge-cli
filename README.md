# agentforge

> Repo bootstrap for agent-driven workflows. Drop a token-optimised `CLAUDE.md` (or `AGENTS.md`) into any project, and link the shared skill vault into the right dot-folder. One command. Idempotent. Cross-platform.

## Why

Every new project follows the same ritual: write a `CLAUDE.md` that respects the [token-management strategies](../llm-skill-vault/Claude_Token_Management_Strategies.md), junction `.claude/skills/` to the central vault, repeat for `.codex/` or `.agents/` if you're running other agent CLIs. `agentforge` makes that a single command.

## Layout

```
agentforge/
├── agentforge.ps1          # PowerShell entry (Win + pwsh on Linux/macOS)
├── agentforge.sh           # Bash entry (WSL2 / Linux / macOS)
├── README.md
└── templates/
    ├── CLAUDE.md.tmpl      # token-optimised, <200 lines, index-style
    └── AGENTS.md.tmpl      # generic agents.md for Codex / Cursor / Kilo
```

## Targets

| Target | Doc | Dot folder | Use case |
|---|---|---|---|
| `claude` | `CLAUDE.md` | `.claude/` | Claude Code CLI (default) |
| `codex` | `AGENTS.md` | `.codex/` | OpenAI Codex CLI |
| `generic` | `AGENTS.md` | `.agents/` | Cursor, Kilo, anything AGENTS.md-aware |
| `all` | both docs | all three | belt-and-braces |

In all cases, `<dot-folder>/skills` becomes a junction (Windows) or symlink (Unix) to the vault.

## Quick start

### Windows (PowerShell)

```powershell
# One-time PATH wiring (Windows): add the agentforge folder to your $PROFILE
$profilePath = $PROFILE
if (-not (Test-Path $profilePath)) { New-Item -ItemType File -Path $profilePath -Force | Out-Null }
@'
function agentforge { pwsh -NoProfile -File "C:\Repos\LLM\agentforge\agentforge.ps1" @args }
'@ | Add-Content $profilePath

# Reload profile, then bootstrap a project
. $PROFILE
cd C:\Repos\my-new-app
agentforge init -Name my-new-app -Stack "TypeScript / Vite / .NET 8"
```

### WSL2 / Linux / macOS

```bash
# One-time PATH wiring
echo 'alias agentforge="bash /mnt/c/Repos/LLM/agentforge/agentforge.sh"' >> ~/.zshrc
# (or ~/.bashrc; adjust path for native Linux/macOS)
chmod +x /mnt/c/Repos/LLM/agentforge/agentforge.sh
source ~/.zshrc

cd ~/repos/my-new-app
agentforge init --name my-new-app --stack "TypeScript / Vite / .NET 8"
```

## Commands

### `init` — full bootstrap

```powershell
agentforge init `
  -Path C:\Repos\my-new-app `
  -Target claude `
  -Name my-new-app `
  -Stack "TypeScript / Vite / .NET 8" `
  -BuildCmd "pnpm build" -TestCmd "pnpm test" -RunCmd "pnpm dev"
```

```bash
agentforge.sh init \
  --path ~/repos/my-new-app \
  --target all \
  --name my-new-app \
  --stack "TypeScript / Vite / .NET 8"
```

### `link` — re-create the skills link only

Useful when the vault path moves or you renamed the dot folder.

```powershell
agentforge link -Target claude -Force
```

### `doctor` — diagnose

```powershell
agentforge doctor -Path .
```

Output:

```
→ agentforge doctor
  Project : C:\Repos\my-new-app
  Vault   : C:\Repos\LLM\llm-skill-vault\skills

✓ vault present (132 skill folders)
  claude    doc:✓  link:✓
             ↳ Junction → C:\Repos\LLM\llm-skill-vault\skills
  codex     doc:·  link:·
  generic   doc:·  link:·
```

## Configuration precedence

Vault root resolution:
1. `-VaultRoot` / `--vault` argument
2. `$env:AGENTFORGE_VAULT_ROOT`
3. `C:\Repos\LLM\llm-skill-vault\skills` (Windows) or `~/repos/LLM/llm-skill-vault/skills` (Unix)

Link type resolution:
1. `-LinkType` / `--link` argument
2. `junction` on Windows, `symlink` on Unix

## Behaviour

- **Idempotent.** Re-running `init` skips existing files and links unless `-Force` / `--force`.
- **Non-destructive by default.** Will not overwrite a hand-edited `CLAUDE.md`.
- **Dry-run.** `-DryRun` / `--dry-run` prints intended actions without filesystem mutations.
- **Junctions on Windows** require no admin rights. Symlinks need admin or Developer Mode.
- **Templates are token-aware.** Render to <200 lines, contain the 95% Confidence Rule, an index-style file map, a Lessons Learned bucket, and a Decisions Log.

## Token-hygiene posture (baked into the template)

The generated `CLAUDE.md` follows the rules in `Claude_Token_Management_Strategies.md`:

- §10 Lean CLAUDE.md (<200 lines, index not data dump)
- §11 Surgical file references (`@path/file.ts`)
- §19 System constitution (stable decisions in Decisions Log)
- §20 Self-evolving Lessons Learned (≤15-word bullets)
- §4 95% confidence rule (in §2 Non-Negotiables)
- Operational §7 cheatsheet for `/clear`, `/compact`, model selection, MCP hygiene

## Extending

Add a new target by:
1. Drop a new template at `templates/<NAME>.tmpl`.
2. Add a row to `$Targets` in `agentforge.ps1` and to `TARGET_ROWS` in `agentforge.sh`.
3. Add it to the `Target` validate set.

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| `failed to create symlink` on Windows | No admin / Dev Mode | Use `-LinkType junction` (default) |
| `vault not found` | `AGENTFORGE_VAULT_ROOT` unset and default path missing | Set the env var or pass `-VaultRoot` |
| Re-running does nothing | Idempotency | Add `-Force` to overwrite |
| Skills missing in WSL2 | Different filesystem mount | Pass `--vault /mnt/c/Repos/LLM/llm-skill-vault/skills` |

## Naming history

Considered: `agentkit`, `prab`, `claudeforge`, `vault-init`, `agentboot`. Settled on **agentforge** — neutral across agents, evokes scaffolding, no NPM clash.
