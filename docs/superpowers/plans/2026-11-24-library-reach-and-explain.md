# Library reach: deploy from the library, say what each agent folder is, explain a missing skill

Status: approved approach, not yet implemented. Branch: `main`. Scope: CLI first; the dashboard changes only where named.

## 1. Problem

Skills from injected repos do not reach, or are not usable in, a person's projects. Three causes, with the evidence found on the owner's machine:

| # | Cause | Evidence |
|---|---|---|
| 1 | `resolveDeployRoot` (`src/infra/paths.js:95-106`) lets `AGENTFORGE_VAULT_ROOT` and `config.vaultRoot` beat the merged library, so `init`, `link` and `doctor` use the vault alone. | Env var names the vault. `doctor` counts 321 skills; the library holds 395. A project's Gemini folder holds exactly the 321 vault skills. |
| 2 | A skills folder can be a real folder of unrelated files, and `doctor` still prints `link:✓` (`src/cli/main.js:211` ticks anything that is not missing, broken or a file). | `ISL.Azure.Infrastructure/.claude/skills` and `.codex/skills` hold 11 unrelated entries and nothing from the library. |
| 3 | Descriptions overflow the listing budget (about 8,000 characters; roughly 65 median descriptions fit). | 42,101 description characters for the vault alone. Plugin skills share the same budget and are not counted by agentforge. |

This plan fixes causes 1 and 2 and adds a tool to diagnose any missing skill. Cause 3 (budget report, cost on `repo add`, set suggestions, on-demand skills, description overrides) is a later plan; the `doctor` fix lines must already say that reaching a project is not the same as fitting the budget.

## 2. Decisions taken

- **D1.** Change the behaviour: a merged library is the default deploy target when sources are registered. `--vault` still overrides. Env and `config.vaultRoot` keep their other job (primary source for `repo sync`, `resolvePrimarySource`, which is not touched).
- Approach: four shippable steps; fix commands are data (argv arrays); a test asserts `doctor` and `explain` never disagree about a folder.
- Ticks: a vault-only link is ticked when no sources are registered. A fresh copy is `~`, and ticked only for copy-only agents (Antigravity).
- `link` in preserve mode writes an ownership marker (own step).
- `explain` exits 0 when the skill reaches the agent (a possibly hidden description is a warning), 1 when it is lost, 2 on usage errors. No `--from` in this version.

## 3. Functional requirements

- **FR1** Deploy target: `init`, `link`, `doctor` and the dashboard read side deploy from the merged view when it exists and `repos.json` has at least one source. Precedence: `--vault`, then merged view with sources, then env, then config, then merged view with an empty registry (unchanged), then the default. When env or config is superseded, print one line saying so and how to override.
- **FR2** `doctor` classifies each agent folder: library link, set link, vault link, other link, broken link, copy (fresh or stale), unrelated directory (entry count, none from the library), partial directory, file, absent.
- **FR3** `doctor` warns once when a project is wired to the vault while sources are registered: "N skills from M injected repos are not included".
- **FR4** `doctor` prints the exact existing `link` command that fixes each non-served folder. It never prints `--force --no-preserve`. Unrelated folders: `link` without `--force` (keeps the user's entries). Vault, other or broken links: with `--force` (repoints the link only). Stale copy: `--link copy`.
- **FR5** The fix for an unrelated folder converges: after running it, `doctor` no longer says "unrelated".
- **FR10** `agentforge explain <skill> [--path P] [--target T] [--json]`: read-only, deterministic, model-free. Steps in order, stopping at the first loss: `source`, `merge`, `built`, `set`, `delivery`, `shadow`, `listing`. Ground truth for delivery is `existsSync(<folder>/<skill>/SKILL.md)`.

Rules for all: nothing is written into a source or vault; output depends only on disk state and is sorted; `apply.js` stays the only code that writes into a project; no magic strings (constants for kinds, marks and steps); `linkHealth` strings stay in the JSON.

## 4. Steps

### Step 1: Deploy target (FR1). Ship alone.

- `src/infra/paths.js`: rewrite `resolveDeployRoot` and its doc comment; export `DEPLOY_ORIGIN` (values equal to the existing `'cli' | 'env' | 'config' | 'merged-view' | 'default'`); add a private `hasInjectedSources(paths)` that reads the registry only after the merged view exists; return an additive `supersedes: 'env' | 'config' | null`. Add a warning when sources are registered but the view is not built (then env or config still apply). A corrupt `repos.json` throws `CONFIG_CORRUPT` unless `--vault` is given.
- `dashboard/server/read-service.js:193`: guard becomes `if (!this.vault)`.
- `src/cli/main.js`: print the `supersedes` line in `cmdProject` and `cmdDoctor`; update HELP (lines 58-59).
- Docs: `README.md:148-156`, `docs/USER-GUIDE.md` (vault precedence and troubleshooting rows), `docs/DASHBOARD.md` if it lists the precedence.
- Tests: `tests/sources.test.js` precedence table (empty and populated registry, view present and absent, env, config, cli; corrupt registry with and without `--vault`; unsynced sources warning); `tests/cli.test.js` (`init` and `link` with env set deploy from the view; `--vault` still wins; a project linked to the vault exits 3 without `--force`, tree unchanged); `tests/dashboard-review.test.js` (without `--vault`, an unreachable `merged-skills` link is refused without probing).
- Acceptance: `node src/cli/main.js link --path D:\Repos\ISL\ISL.Azure.Infrastructure --target gemini --dry-run` names `merged-skills (merged-view)` and the superseded env line; nothing changes. Then `init` into a scratch folder and confirm the link target.

### Step 2: Doctor classification (FR2, FR3, FR4). Read-only.

- New `src/domain/wiring.js`: frozen `WIRING` kinds and `MARK` values; pure `classifyWiring(observation)`; pure `fixCommand({ projectRoot, targetId, kind })` returning argv data.
- New `src/application/wiring.js`: `describeWiring(row, ctx)` from an `inspectProject` row and `classifyFolder` (`src/application/adopt.js:23`); `notIncluded(view)` from `computeLibrary` (run only when some row is vault-wired and sources are registered). Primary root from `resolvePrimarySource` ignoring `--vault`; a `VIEW_AS_SOURCE` throw skips FR3 with a grey note. List skill names with `readdir` plus a `SKILL.md` check, never `fingerprint`. Do not change `inspectProject` (shared with the dashboard, `check` and `sets`).
- `src/application/sets.js` `readsOf`: optional third argument `primaryRoot`, returning `{ kind: 'vault' }`.
- `src/deployment/copy-state.js`: add `source` to the returned state (additive).
- `src/cli/main.js` `cmdDoctor` (184-217): attach `t.wiring`, replace the `linkMark` at 211, print kind, entry counts and the `fix:` line, add `report.notIncluded` and `wiring` to `--json`. The exit code stays tied to `report.ok`.
- `fix` lines say that linking the whole library does not fix the listing budget, and point to a set (`link --set`) for projects that do not need every skill.
- Tests: new `tests/wiring.test.js` (table over every kind; exact `fix` argv; no fix contains `force` with `no-preserve`); `tests/cli.test.js` (library link, set link, vault link with one source, unrelated directory, stale and fresh copy; whole-tree snapshot unchanged after `doctor`; `linkHealth` unchanged).
- Acceptance: `doctor --path D:\Repos\ISL\ISL.Azure.Infrastructure` shows `claude` and `codex` as unrelated folders with the `link` command, and `gemini` as vault-only with the FR3 line.

### Step 3: Converging fix (FR5). The only step that writes into projects.

- `src/deployment/plan.js` `planSkillsLink` preserve branch (124-131): attach a marker to the `copy-entries` action only when `readMarker(dotDir)` is null (never replace an existing one: `apply.js:84` rewrites `names`). No change to `apply.js`.
- Tests: extend `tests/plan-apply.test.js:71-94` (marker present and `names` equal to the copied entries; an existing marker is not replaced; the gitignore test still passes); CLI round trip (unrelated folder, `link`, `doctor` shows a copy that is up to date); a user-owned skill of the same name stays byte-identical.
- Acceptance: on a scratch copy of the ISL `.claude/skills` only, run the printed command and re-run `doctor`. Do not run it on the real project first.

### Step 4: `explain` (FR10).

- Add to `src/discovery/listing-budget.js`: `describeListing(skills, name, opts)` returning `shown | at-risk | no-description` (name tie-break; never claims "dropped" for one skill). Extract `lintFolder(root)` from `src/application/health.js` (lines 17-24) without changing `inspectLibrary`'s output.
- Add `whyInSet(set, entry)` to `src/domain/sets.js`, with a test pinning it to `resolveSet` membership.
- New `src/application/explain.js`: `explainSkill(...)` returns data only: `{ skill, target, folder, wiring, reaches, lostAt, steps: [{ id, status, summary, facts, fix }] }`, statuses `ok | degraded | lost | skipped`. Later steps after the first loss are `skipped`. Uses `computeLibrary`, `inspectProject`, `describeWiring`, `findShadows` (`src/discovery/skill-lint.js:146-169`, target mapped to a tool by a constant) and `describeListing`. If the chain says `ok` but the folder lacks the skill, the step is `lost` with "unexplained", never a guess.
- `src/cli/main.js`: `case 'explain'`, `cmdExplain`, HELP entry. `positional[0]` is required (usage error otherwise); `--target all` is a usage error; default target `claude`.
- Tests: new `tests/explain.test.js` (one fixture per step as the first loss; ordering with two faults; read-only snapshot; two runs deep-equal; exit codes 0, 1, 2; the no-disagreement invariant with `doctor` across the wiring fixtures).
- Acceptance: for a skill that only an injected source holds, `explain <skill> --path <ISL project> --target gemini` reports the first loss at `delivery` (vault-only link) before Step 1's fix is applied to that project, and no loss after it.

### Step 5: Worktrees and duplicates (FR11-FR13). No manual cleanup.

Found later: Codex lists a skill once per folder that holds a copy of it. The Backend repo has 7 folders with `.codex/skills` (3 plain copies, 2 library links, 2 vault-only links) among 51 registered worktrees, so one skill shows 5 or more times in `$plan`.

- **FR11** `doctor` and `check` group remembered projects by git repository (`git worktree list`) and report, per repository: which worktrees wire skills, how each is wired (Step 2 kinds), and "each skill will be listed N times by Codex".
- **FR12** `agentforge tidy [--path P | --repo R] [--home PATH] [--apply]`. Dry run by default; it prints exactly what it would do and changes nothing without `--apply`.
  - Picks one home per repository (the main working tree, or `--home`).
  - In every other worktree it removes only wiring agentforge can prove is its own: links to the library or the vault, and plain folders whose every entry is a library skill with an identical content digest (marker or not, reusing `classifyFolder` and `digestSkill`).
  - Anything else (a folder with a skill of the user's own, differing content, an unreadable entry) is left untouched and listed as "left alone: why".
  - Removal goes through `apply.js` (the only writer into a project); links are removed link-only; every action is written to a manifest under `~/.agentforge/` so it can be undone with `tidy --undo`.
  - Then (re)wires the home to the library or a set, using the Step 1 default.
- **FR13** Codex sees one entry per location, so the cleaner end state is one user-level wiring: `link --user --target codex [--set NAME]` points `~/.agents/skills` at the library or a set, and `tidy` then needs no per-worktree wiring at all. Open decision: whether this is the default (see the question to the owner). It must warn when linking the full library at user level, because every session then carries every description.
- **Decision (owner):** the default end state is one user-level set. Codex reads `~/.agents/skills` pointing at a set; `tidy` removes per-worktree wiring. This pulls a minimal FR6 forward: `agentforge set suggest` proposes a starter set (by category, within the listing budget, shortest descriptions flagged) as a preview that the owner approves; it never applies silently. The full suggestion engine stays in the later plan.
- Acceptance: on the Backend repo, `tidy --dry-run` lists the 7 folders and what it would do to each; after `--apply`, `$plan` shows each skill once; `tidy --undo` restores the removed links and copies exactly.
- Tests: temp git repo with several worktrees (`git worktree add`), one of each wiring kind, a plain folder with an own skill (must be left alone), a plain folder of identical copies (removed), differing content (left alone), manifest and undo round trip, dry run leaves the tree byte-identical.

## 5. Behaviour changes to announce

- A project already linked to the vault stops on `link` (exit 3) until `--force`; `--force` removes the link only.
- A corrupt `repos.json` now stops `init`, `link` and `doctor` unless `--vault` is given, as `repo sync` already does.
- `init` on a previously wired project skips that target's plan on the new conflict.
- Existing projects are not changed by themselves; each needs a fresh `link`.

## 6. Out of scope (next plan)

Budget report by source and category, cost warning on `repo add` and `repo sync`, set suggestions, on-demand skills (needs a per-agent research task first), description overrides, `explain --from` and `--ask-agent`, `doctor --fix` and bulk relinking, dashboard wiring kinds, a merged-view staleness check, and the `.gitignore` side effect of merging into a user's folder.

## 7. Not verified when this was written

No test run for any of this. Checked by reading: the dashboard fixture passes `vault` explicitly, so the early `--vault` return protects it. Not read: `dashboard/web` handling of `deployment.origin`, and `apply.js` beyond the marker line. How Codex, Gemini and Cursor behave at their listing limits is unknown. The target-to-tool mapping for shadows (`generic`, `antigravity`) needs checking against `docs/DASHBOARD.md` before Step 4. Run `npm test` and `npm run dashboard:test` before and after each step.
