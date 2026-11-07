# Agentforge — User Guide

This guide is for an engineer who has never used Agentforge. It explains what the tool is for, the five words you need to know, how to do the everyday jobs, and what to do when something refuses to run. Read sections 1 to 4 once; keep sections 5 onward as reference.

> **Status.** Everything in this guide works today except the parts marked **[planned]**: the interactive menu (`agentforge` with no arguments), profiles, the remembered project list, and the `af-manage` harness entry. Those are the next work items; the command-line forms described alongside them already exist and are what the menu will call.

---

## 1. What Agentforge does

You keep AI coding skills (folders with a `SKILL.md`) in one personal **vault**. Other people publish skills in their own git repositories. Every AI coding tool you use (Claude Code, Codex, Gemini CLI, Cursor) looks for skills in its own dot-folder inside each project.

Agentforge does three things:

1. **Attaches skill repositories to your vault.** You register a local folder or a git URL as a *source*. Agentforge fetches it, finds the skills in it, and merges them with your vault into one combined folder called a *view*.
2. **Wires projects to that view.** In any project, one command writes the instruction file the tool expects (`CLAUDE.md`, `AGENTS.md` or `GEMINI.md`) and links the tool's dot-folder to the view. The project sees every skill without a copy of any of them.
3. **Tells you the truth about the result.** `doctor` reports what is actually linked where, and every command that changes something shows you its plan first and refuses when the situation is not what it expects.

What it deliberately does **not** do: run skills, edit your hand-written instruction files, or guess. If it is unsure, it stops with exit code 3 and tells you what to decide.

## 2. The five words

| Word | Meaning | Where it lives |
| :-- | :-- | :-- |
| **Vault** | Your own skills. One folder, one skill per sub-folder, each with `SKILL.md`. Agentforge never writes into it. | `D:\Repos\LLM\llm-skill-vault\skills` (configurable) |
| **Source** | A registered place skills come from: a local folder or a git repository. Your vault is the *primary* source; the rest are attached. | `~/.agentforge/repos.json`; git clones in `~/.agentforge/repos/` |
| **View** | A generated folder of links, one per skill, built from the vault plus the attached sources. It is an output. Delete it and rebuild it any time; never edit it. | `~/.agentforge/merged-skills/` |
| **Profile** **[planned]** | A named selection of skills (include, exclude, extends). Each profile is built as its own view, so a project can see a subset. | `~/.agentforge/profiles.json`, views in `~/.agentforge/views/<profile>/` |
| **Target** | The contract one AI tool expects: which instruction file and which dot-folder. | `claude` → `CLAUDE.md` + `.claude/`, `codex` → `AGENTS.md` + `.codex/`, `generic` → `AGENTS.md` + `.agents/`, `gemini` → `GEMINI.md` + `.gemini/` |

A **project** is any folder you point Agentforge at. Wiring a project means: instruction file written, `<dot>/skills` linked to a view, `<dot>/skills` added to `.gitignore`.

## 3. Install

Requirements: Node.js 20 or newer, git on `PATH`. No `npm install` is needed; the tool has no dependencies.

**Windows (PowerShell).** Add this line to your `$PROFILE` and restart the shell:

```powershell
function agentforge { pwsh -NoProfile -File "D:\Repos\LLM\llm-agentforge-cli\agentforge.ps1" @args }
```

**WSL / Linux / macOS.** Add to `~/.zshrc` or `~/.bashrc`:

```bash
alias agentforge="bash /mnt/d/Repos/LLM/llm-agentforge-cli/agentforge.sh"
```

**Tell it where your vault is** (once, user scope):

```powershell
[Environment]::SetEnvironmentVariable('AGENTFORGE_VAULT_ROOT', 'D:\Repos\LLM\llm-skill-vault\skills', 'User')
```

Check:

```
agentforge doctor
```

You should see `✓ vault present (321 skills with SKILL.md)` or similar. If you see `vault not usable`, the path is wrong; see section 9.

## 4. Your first fifteen minutes

Follow these in order in a terminal. Each step says what you should see.

**Step 1. Look at what you have.**

```
agentforge repo list
```

Expected the first time: `no sources registered`. Your vault is not listed here; it is always present.

**Step 2. Attach a repository.** A local folder:

```
agentforge repo add D:\Repos\LLM\llm-skills-mattpocock --name mattpocock
```

or a git repository:

```
agentforge repo add https://github.com/someone/their-skills.git --name theirs
```

Expected: `✓ registered local source "mattpocock" (…)` and a hint to run `sync`. Nothing has been fetched or built yet. Names must be letters, digits, `.`, `_`, `-`; that is on purpose, because the name becomes a folder name.

**Step 3. See what it would contribute, without changing anything.**

```
agentforge repo sync --no-fetch --dry-run
```

Expected, for example:

```
→ agentforge repo sync
  Vault  : D:\Repos\LLM\llm-skill-vault\skills
  View   : C:\Users\you\.agentforge\merged-skills
! Mode   : DRY RUN

! tdd: kept vault, dropped mattpocock
(dry) would link 335 skills (321 from vault, 14 from mattpocock)
```

The `kept … dropped …` lines are **collisions**: two sources have a skill with the same folder name. Your vault wins by default. If you want the attached repository's version instead, add `--force` (applies to all collisions). Read section 6.3 before doing that.

**Step 4. Build the view.**

```
agentforge repo sync
```

For git sources this clones or fast-forwards them first, then builds the view. The view is built in a staging folder and swapped in, so a failure never leaves a half-built view. Expected: `✓ merged view built: 335 skills linked (…)`.

**Step 5. Wire a project.** From inside the project, or with `--path`:

```
cd D:\Repos\my-app
agentforge init --target claude --name my-app --stack "TypeScript / .NET 8" --dry-run
```

Read the plan. It lists every write it would make, one line each. Then run it without `--dry-run`. Expected:

```
→ target: claude
✓ write D:\Repos\my-app\CLAUDE.md (3.0 KB)
✓ mkdir D:\Repos\my-app\.claude
✓ junction: D:\Repos\my-app\.claude\skills -> C:\Users\you\.agentforge\merged-skills
✓ append to D:\Repos\my-app\.gitignore: .claude/skills
```

Notice the link points at the **view**, not the vault, because a view exists and has a registry behind it. That is the normal state once you have attached anything.

**Step 6. Confirm.**

```
agentforge doctor
```

Expected: `claude    doc:✓  link:✓  link` with the resolved target underneath. Run `init` again: it reports `already exists` and `up to date` and changes nothing. That is the idempotency you rely on.

Open `CLAUDE.md` and fill in the **Map** and **Build & Run** sections by hand. Agentforge will never overwrite that file again unless you pass `--force`.

## 5. The interactive menu **[planned]**

Running `agentforge` with no arguments opens a menu. It is the same operations as the commands below, with pickers instead of typed paths, and it always shows the plan and asks before applying.

```
agentforge
  1  Sources      list · attach local folder · attach git URL · fetch · detach
  2  Skills       browse vault and each source · search · open a SKILL.md · show collisions
  3  Views        build default view · profiles: list · create · edit · build · preview
  4  Projects     attach a project · pick targets and profile · preview · apply · doctor
  5  Doctor       vault, views and every remembered project
  /  search       q  quit
```

Projects you attach are remembered in `~/.agentforge/projects.json`, so next time you pick them from a list.

From `gd-tool-harness`, the same menu is the tool `af-manage` under the **Agents** category: `gdt` → Agents → *Agentforge: manage skill sources and projects*.

## 6. Everyday jobs

### 6.1 Update attached repositories

```
agentforge repo fetch            # clone or fast-forward every git source; the view is NOT touched
agentforge repo sync --no-fetch  # rebuild the view from what is on disk
```

or both at once with `agentforge repo sync`. Fetch and build are separate so that an unattended job (a scheduled hook) can refresh the cache without changing what your projects see. A fetch that fails for one source reports it and exits 1; the others still update.

### 6.2 See what a source contributes

```
agentforge repo list
```

shows each source with its state (`exists`, `cloned`, `not fetched`, `missing`), its git revision, and how many skills were found. Skills are found by reading `.claude-plugin/plugin.json` if the repository has one, otherwise by scanning four levels deep for folders containing `SKILL.md`. A candidate is rejected if it is outside the repository, is not a folder, has no `SKILL.md`, or is reached through a link. `--json` gives the same data for scripts.

### 6.3 Resolve a collision

Two sources, same folder name. The view can hold only one. Default: the vault wins. Options:

1. **Keep yours.** Do nothing. The dry run will keep listing the collision so you remember it exists.
2. **Prefer the attached version.** `agentforge repo sync --force`. This flips *every* collision, not just one. Check the dry run first.
3. **Keep both.** Rename the folder in your vault (you own it) and rebuild.

A collision is reported, never silent. If you see one you did not expect, a source you attached is shipping a skill with the same name as yours; read both `SKILL.md` files before choosing.

### 6.4 Wire a second tool in the same project

```
agentforge init --target gemini
```

or all four at once with `--target all`. `codex` and `generic` share `AGENTS.md`; it is written once. Each target gets its own dot-folder link.

### 6.5 A project already has a `.claude/skills` folder

Three cases, and `link` handles each differently. You do not have to work out which one you are in; the tool tells you.

| What is there | What happens |
| :-- | :-- |
| An ordinary folder with your own skills | They are kept. Skills from the view that are missing are **copied** in (a copy, because you cannot link a folder into a folder). Nothing of yours is overwritten. |
| A link already pointing at the right view | Nothing to do. |
| A link pointing somewhere else, or a broken link | **Refused**, exit 3, with the message `link to another source … rerun with --force to repoint`. Nothing is merged into a folder that belongs to another vault. `agentforge link --force` removes the link (only the link, never what it points at) and relinks. |

To throw away an ordinary folder and replace it with a link: `agentforge link --force --no-preserve`. This is the only command that deletes a folder, and it checks right before deleting that the path is still an ordinary folder and not a link.

### 6.6 Detach a repository

```
agentforge repo remove mattpocock
agentforge repo sync --no-fetch
```

Remove unregisters the source and deletes its cached clone if it was a git source. It never deletes a local folder you registered. The view is not rebuilt automatically; the second command does that.

### 6.7 Use a profile **[planned]**

```
agentforge profile create backend --include "vault/*" --include "mattpocock/tdd" --exclude "vault/frontend-*"
agentforge repo sync                      # builds merged-skills AND views/backend
agentforge link --profile backend         # this project now sees only the backend selection
agentforge doctor                         # reports: linked to profile "backend"
```

A profile can `extends` another. A cycle is an error.

### 6.8 Check everything

```
agentforge doctor            # this project
agentforge doctor --json     # for scripts; exit 1 if the vault is unusable or a link is broken
```

Doctor distinguishes *present* from *healthy*: a dangling link shows as `✗ broken` with the dead target, not as a tick.

## 7. Using it from gd-tool-harness

The harness (`gdt`) gives every command a risk level, a preview-then-apply gate, an approval pin and a ledger entry. Agentforge registers these tools:

| Tool | Risk | What it runs |
| :-- | :-- | :-- |
| `af-doctor` | ReadOnly | `doctor` (needs `-- --path <project>`) |
| `af-source-list` | ReadOnly | `repo list` |
| `af-source-fetch` | Changes | `repo fetch` (safe to schedule as a hook) |
| `af-view-build` | Changes | preview `repo sync --no-fetch --dry-run`, apply `repo sync --no-fetch` |
| `af-init` | Changes | preview `init --dry-run`, apply `init` (needs `-- --path <project>`) |
| `af-link-repoint` | Destructive | `link --force --no-preserve` (needs `-- --path <project>`) |
| `af-source-remove` | Destructive | `repo remove <id>` |
| `af-manage` **[planned]** | Changes, interactive | the menu from section 5 |

Examples:

```powershell
gdt -Run af-view-build                   # preview only
gdt -Run af-view-build -Apply            # preview, then build
gdt -Run af-init -Apply -- --path D:\Repos\my-app --target claude
```

Use the `--path` spelling after `--`; the harness matches required arguments literally.

## 8. Command reference

```
agentforge init   [--path P] [--target claude|codex|generic|gemini|all] [--name N] [--stack S]
                  [--owner O] [--build C] [--test C] [--run C] [--vault V]
                  [--link junction|symlink|copy|none|auto] [--dry-run] [--force] [--no-preserve]
agentforge link   [--path P] [--target T] [--vault V] [--link L] [--dry-run] [--force] [--no-preserve]
agentforge doctor [--path P] [--vault V] [--json]
agentforge repo add <url-or-path> [--name ID] [--branch B]
agentforge repo remove <ID>
agentforge repo list [--json]
agentforge repo fetch [ID]
agentforge repo sync [--vault V] [--force] [--no-fetch] [--dry-run]
agentforge help
```

PowerShell spelling works everywhere: `-Path`, `-Target`, `-DryRun`, `-NoPreserve`, `-VaultRoot`, `-LinkType`.

**Which vault does a command use?** First match wins:

1. `--vault`
2. `AGENTFORGE_VAULT_ROOT`
3. `vaultRoot` in `~/.agentforge/config.json`
4. `~/.agentforge/merged-skills`, but only if `repos.json` exists beside it. A view with no registry is ignored with a warning; it is a leftover, not a source.
5. The built-in default.

`repo sync` uses the same chain for the *primary source* except step 4: the view is never allowed as a source.

**Link types.** `auto` picks junction on Windows (no admin rights needed) and symlink elsewhere. `copy` copies the whole view into the project (use when a tool cannot follow links). `none` does nothing at all, even with `--force`.

**Exit codes.**

| Code | Meaning | What to do |
| :-- | :-- | :-- |
| 0 | Done, or nothing to do | — |
| 1 | Failure: git, filesystem, corrupt config, unusable vault | Read the message; fix the cause |
| 2 | Usage: bad option, invalid name, unsupported URL | Fix the command |
| 3 | Refused: a conflict or safety rule. **Nothing was applied.** | Read the reason; decide; rerun with the flag it names |

## 9. When it refuses

Agentforge prefers a clear refusal to a guess. The common ones:

| Message | Why | Fix |
| :-- | :-- | :-- |
| `vault root does not exist or is not a directory` | Vault path wrong | Set `AGENTFORGE_VAULT_ROOT` or pass `--vault`; `doctor` prints which origin it used |
| `ignoring …merged-skills: no repos.json behind it (orphaned view)` | A view exists from an old run but no sources are registered | `agentforge repo sync` to rebuild it with a registry, or delete the folder |
| `link to another source (→ …); rerun with --force to repoint it` | `<dot>/skills` points at a different vault | Decide which vault this project should use; `link --force` repoints |
| `directory exists; use --force --no-preserve to replace it` | You asked for no-preserve without force | Add `--force` if you really want the folder deleted |
| `… appeared since planning` / `STALE_PLAN` | Something changed between the plan and the apply | Rerun; the new plan will reflect the current state |
| `… is the merged view, not a source` | You pointed `repo sync --vault` at the view | Point it at the real vault |
| `… is not a link; the view must contain only links` | Someone copied real files into `merged-skills` | Move them out, then rebuild |
| `repos.json is not valid JSON … refusing to continue` | The registry is corrupt | Fix the JSON by hand. It is never overwritten for you |
| `invalid source ID` | Name has `/`, `\`, spaces or starts with `.` | Pass `--name something-simple` |
| `unsupported git URL` | Only `https://`, `ssh://`, `git@host:` are accepted | Use one of those |

## 10. What is on disk

| Path | What | Safe to delete? |
| :-- | :-- | :-- |
| `~/.agentforge/repos.json` | Registered sources | No; this is your configuration |
| `~/.agentforge/config.json` | Optional `vaultRoot` | Yes; falls back to env var or default |
| `~/.agentforge/repos/<id>/` | Git clones | Yes; `repo fetch` recreates them |
| `~/.agentforge/merged-skills/` | The default view (links only) | Yes; `repo sync --no-fetch` recreates it |
| `~/.agentforge/views/<profile>/` **[planned]** | Profile views | Yes; same |
| `~/.agentforge/projects.json` **[planned]** | Remembered projects for the menu | Yes; you lose the list, not the projects |
| `<project>/<dot>/skills` | A link (or, with `copy`, a copy) | Yes; `link` recreates it |
| `<project>/CLAUDE.md` etc. | Yours after the first write | **No** |

## 11. Rules the code enforces, so you do not have to

- Planning is separate from doing. Every command builds a list of actions first; `--dry-run` prints that list and stops; apply re-checks each action's precondition immediately before performing it.
- Removing a link removes the link. It is checked to be a link, and to point where the plan expected, right before removal.
- The only recursive delete is `link --force --no-preserve` on a path verified to be an ordinary folder.
- Git is invoked as a program with an argument list, never a shell string. Clone disables hooks and submodules.
- A skill is a folder inside its source (also after resolving links) that contains `SKILL.md`. Nothing else is published.
- The view is an output. It is never a source, and it is rebuilt by swap, never by delete-then-fill.
- `.gitignore` receives only `<dot>/skills`. Your instruction file and the rest of the dot-folder are yours to commit or not.

## 12. For the engineer who has to change it

```
src/cli/main.js          entry; owns output and exit codes; everything else is injected (env, home, cwd, streams)
src/cli/args.js          one parser for both option spellings
src/application/         use cases: sources.js · sync.js · project.js   (no console, no process.exit, no implicit paths)
src/deployment/plan.js   read-only; turns observations into actions
src/deployment/apply.js  the only module that writes to a project
src/deployment/build-view.js   compute + staged swap of a view
src/discovery/           find and validate skills
src/domain/              targets, source-ID rules, errors
src/infra/               paths & config, git, filesystem inspection
tests/                   node --test; every test builds a fake home, vault and project in a temp folder
```

Run `npm test` before and after any change. Add a target by adding a template and one row in `src/domain/targets.js`. Add a command by adding a use case in `src/application/` and a `case` in `main.js`; keep `console` and `process.exit` out of the use case so the menu and the harness can call it too.
