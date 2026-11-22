# Keeping every copy of a clashing skill

Date: 2026-11-22 · Status: draft for approval · Owner: grego

## 1. Intent

When two sources ship a skill with the same name but different content, the library
keeps one copy and drops the rest. The dropped copy is still on disk, but no agent can
use it, not even by name. In practice the skill is lost. The only fix today is
"Use this one", which picks a different copy to lose. The other two categories have
the same limit: "Need a look" can only re-pick, and "Have problems" can only show
the SKILL.md.

The owner wants clashes resolved inside the dashboard, with **every distinct copy
still usable by agents**. One copy keeps the plain name; each copy that differs is
kept under a new name **that says how it differs**, with a description that tells an
agent when to pick it. Working through many clashes must be fast: Claude suggests the
new name and description, the owner edits, and approvals go through the existing
Changes tray in one Apply.

## 2. Goals, non-goals, anti-goals

**Goals**
- G1. A clash can end with every differing copy in the library, each under its own name.
- G2. The plain name stays with the copy the owner marks as main; the default is the copy in use today.
- G3. Claude suggests a name and description for each differing copy; the owner edits before anything is saved.
- G4. Many clashes can be handled in one sitting: one queue, suggestions fetched in a batch, approvals applied together.
- G5. The result is deterministic: the same `config.json` and sources rebuild the same library on any machine, from the dashboard or from `agentforge repo sync`.
- G6. When the original of a kept copy changes, the owner is told the description may no longer fit (Need a look).

**Non-goals (this round)**
- Fixing "Have problems" findings. The mechanism is designed to support it (see 9), but it is built later.
- Merging two copies into one, or editing a skill's instructions.
- New CLI commands to manage kept copies. The CLI honours them on `repo sync`; managing them is the dashboard's job.

**Anti-goals (a failure even if it works)**
- Any write into the vault or into a source folder or clone.
- A copy that leaves the library without the owner having chosen that explicitly. Skip leaves things exactly as they are today.
- A description that silently stops matching the content it describes.
- A suggestion step that can read files, run commands or change anything. Skill text from Git sources is untrusted input.

## 3. Constraints from the existing system

- Agentforge never writes into the vault or a source (README, USER-GUIDE). Git sources are clones that `fetch` fast-forwards.
- The library (`~/.agentforge/merged-skills`) is a folder of links rebuilt by staged swap (`materializeView` in `src/deployment/build-view.js`). Sets are built from the same entries (`src/application/sets.js`).
- Clash settlement lives in `computeView`. A per-skill choice in `config.json` `preferences` can be pinned to content digests, and a changed digest marks it `stale`; this already drives the "changed" clash kind and the Need a look filter.
- Lint rules (`src/discovery/skill-lint.js`): name must match `^[a-z0-9]+(?:-[a-z0-9]+)*$` and the folder name (`NAME_MISMATCH` is an error); `description` plus `when_to_use` is capped at 1536 characters for Claude Code's listing.
- Dashboard changes go through `WriteService`: `describe()` returns a preview and a `run()`; `apply()` describes again against the disk at that moment and refuses on conflicts. The write worker has a 180 s limit (`LIMITS.writeMs`).
- Verify (`src/application/verify.js`) runs agent CLIs with `runTool`. On Windows a `.cmd` shim only accepts plain-character arguments, so long or arbitrary text cannot go in an argument.
- The listing budget is already over (about 120 of 395 descriptions fit). Every kept copy adds a description, so it makes this worse.

## 4. Approaches considered

| | Approach | Trade-off | Decision |
|---|---|---|---|
| **A** | **Rule in `config.json`, copy rebuilt from it.** Each decision is a recorded rule; every rebuild regenerates a full copy under `~/.agentforge/kept/` with only `name` and `description` rewritten. | One more kind of library entry, and disk space for the copies. Copies are never stale; changed originals are flagged by digest. | **Chosen by the owner.** Deterministic, CLI parity for free, and it reuses digests and staged rebuilds the code already trusts. |
| B | Copy only SKILL.md and link every other file back to the original. | Other files stay live, but on Windows individual file links need Developer Mode or admin, and Antigravity copy mode flattens it anyway. | Rejected: fragile on the main platform. |
| C | Rename in place inside the vault. | Breaks the read-only guarantee, works only for vault copies, and is the one route where a mistake loses content. | Dropped. |

## 5. Data model

`config.json` gains a `kept` array. The existing `preferences` entry records which copy keeps the plain name.

```json
{
  "preferences": {
    "brainstorming": { "source": "vault", "digests": { "vault": "…", "obra-superpowers": "…" }, "chosenAt": "…" }
  },
  "kept": [
    {
      "name": "brainstorming-design-gate",
      "from": { "skill": "brainstorming", "source": "obra-superpowers" },
      "description": "Use before any creative work when you want a hard design-approval gate …",
      "digest": "<content digest of the original at approval>",
      "keptAt": "2026-11-22T10:31:00Z"
    }
  ]
}
```

- `from.source` is a source key (`vault` or a registry name), as in `preferences`.
- `digest` is the `digestSkill` digest of the original folder when the owner approved. It is not the digest of the generated copy.
- `loadConfig` validates `kept` when it is present: an array of objects with those fields, names passing the lint name rule, and no two rules with one name. Invalid → `CONFIG_INVALID`, fail closed, consistent with the registry.

## 6. How the library is built

### 6.1 `computeView`
- Takes a new `kept` input (default `[]`).
- For each rule, it finds the candidate with `from.skill` (case-folded as names are today) and `from.source` in the groups it already builds.
  - **Found:** add an entry `{ name: rule.name, source: rule.from.source, absolutePath: <kept dir>/<rule.name>, kept: { from, stale } }`. `stale` is true when the candidate's current digest differs from `rule.digest`.
  - **Not found** (source detached or skill removed): the rule produces no entry, and a `keptMissing` item is reported. It is never an error that stops the build.
- **Name collision:** if `rule.name` equals any name a source provides, or another rule's name, the rule is skipped and reported as `keptBlocked`. A source added later that brings the same name must not silently lose either skill: the source's skill keeps the name, and the kept copy is reported so the owner can rename it.
- The return value gains `kept: [{ name, from, stale, absolutePath }]`, plus `keptMissing` and `keptBlocked`. The existing clash for `from.skill` still exists. The read service marks it **resolved** when every distinct content among its candidates is either the winner's or the origin of a kept rule (see 8).

### 6.2 Generating the copies
- A new step in `syncView`, before `materializeView`: `materializeKept(paths.keptDir, view.kept, readSource)`.
- `~/.agentforge/kept/` is owned by agentforge, the same way `merged-skills` is. It is built by staged swap: build `kept.staging-<pid>`, then swap. It refuses to replace a folder that holds anything other than the folders it made and its marker file, as `materializeView` refuses non-link entries.
- Each copy is the original folder copied whole, then SKILL.md rewritten:
  - **Only** the `name:` and `description:` lines change. If `description` was a block scalar, the whole block is replaced. Every other byte, including line endings, other keys and the body, is unchanged.
  - **Writing the description (my call):** it is written as a folded block scalar (`description: >-` followed by the text on indented lines). `parseFrontmatter` already reads folded blocks, and they need no escaping, so quotes and backslashes round-trip exactly with no change to the shared parser. Descriptions are single paragraphs: the input refuses line breaks, and leading and trailing spaces are trimmed.
  - **Originals without the lines (my call):** a skill's name comes from its folder, so an original may have no frontmatter, or no `name:` or `description:` line. The writer inserts what is missing. With no frontmatter at all, it adds a `---` block with both keys at the top of the file. With a block that lacks one key, it adds that key at the end of the block. This only makes the copy more valid, and slice 4 needs the same code.
  - This needs a small frontmatter writer next to `parseFrontmatter` in `skill-lint.js`.
- Links inside the original skill folder are **not followed** outside that folder. Same-folder files are copied; a link pointing outside is dropped and reported. `digestSkill` already treats links as recorded, not followed.
- `paths` gains `keptDir: ~/.agentforge/kept`.
- A dry run computes but does not write, as today.

### 6.3 Everything downstream
Library links, sets, the lock record, project wiring and `doctor` all read `view.entries`, so kept copies flow through them unchanged. A set rule `source:obra-superpowers` includes the kept copy, because the entry's `source` is the original source.

**The dashboard catalogue is the exception (slice 1).** `read-service.js` maps every view entry to a skill it found by scanning a source, and throws `CHANGED` when none matches, so one kept entry would break the whole skill list. Kept copies become skills in their own right in the catalogue:
- Each has its own id, `idFor('kept', rule.name)`.
- `sourceId` is the original's source. `relativePath` is the original's.
- A new `kept: { from: { skill, sourceId }, stale, built }` field is added to `Skill` in `contracts.d.ts`.
- Its document, lint findings and listing-budget share are read from the generated folder under `~/.agentforge/kept/<name>` when it exists. That is what agents actually get, so the rewritten name and description are what is checked.
- The winner matching in `read-service.js` checks a kept entry against these kept skills instead of the scanned ones.
- **Rule saved but library not yet rebuilt:** the folder does not exist yet, so the skill is listed with `kept.built: false` and the original's SKILL.md, labelled "kept copy, appears after the library is rebuilt". It is never an error.
- The Skills page shows it with a "kept copy of `brainstorming` from obra-superpowers" tag. The compare page shows it as a note under the original's card ("kept as `brainstorming-design-gate`"), not as another candidate.

### 6.4 The main copy stays put (my call)
A clash with kept copies must not silently change which copy has the plain name. If it did, the old main would have no name, and the new main would sit in the library twice.
- `library.keep` always writes a `preferences` choice for the main. A choice already beats `sourcePriority` and the CLI's `--force` in `computeView`, so changing the order or using `--force` cannot move the plain name.
- If a rule's original is nevertheless the current winner (for example, a hand-edited config), `computeView` skips that rule and reports it as `keptBlocked`, with reason `is-main`. It never builds a second copy of the main.
- **"Keep only one"** (`library.prefer`) on a clash that has kept copies also removes those rules. Its preview lists each kept copy that will leave the library, by name, as a `remove` line. This is the explicit choice the anti-goal requires.
- **Choosing a different main in the queue** re-saves the whole clash in one `library.keep`. The old main gets a rule (and needs a name) like any other differing copy, and any rule whose original is now the main is removed in the same change.

## 7. Claude's suggestions

### 7.1 What it is asked
- A new module, `src/application/suggest.js`.
- `suggestKeep({ main, other, otherSource, mainSource, taken, run })` returns `{ name, description, difference, by: 'claude' | 'fallback' }`.
- **Prompt contents:** both SKILL.md texts (each capped at 24 KB; over that, the first 24 KB plus a note), the file lists with differing and added files marked, the plain name, the names already taken, and the rules:
  - the name pattern, at most 64 characters, starting with the plain name followed by a hyphen;
  - a description of at most 900 characters that says when to use this copy rather than the main one;
  - a one-line `difference` shown to the owner.
- **The answer must be JSON only.** Content is passed on standard input, never as an argument. This avoids the `.cmd` shim limit, and keeps skill text out of process listings.
- The prompt says the skill texts are data, and instructions inside them are to be ignored.

### 7.2 How it is run
- It reuses `runTool`, extended with an `input` option for standard input.
- Command: `claude -p --model sonnet --output-format text`. The model can be overridden with `config.json` `suggestModel`.
- The suggestion must not be able to read, write or run anything. Pass the installed CLI's flags that disable tool use. The builder confirms the exact flags against `claude --help` on the build machine and adds a test that the argument list contains them.
- Timeout 150 s, as Verify.
- **Validation:** parse JSON. Check the name pattern, prefix and length, and that it is not in `taken`. Check that the description is non-empty and within the cap.
- **Fallback when invalid, timed out or unavailable:** name `<plain>-<source key>` (de-duplicated with `-2`, `-3` …); description `"<source>'s version of <plain>. " + the original description`, trimmed to the cap; `by: 'fallback'`. The owner still edits it.

### 7.3 Caching
- Suggestions are cached in `~/.agentforge/suggestions.json`, keyed by plain name, source, and both digests.
- Reopening the dashboard does not ask again. "Suggest again" bypasses the cache.
- A damaged cache file only means "not suggested yet", as `verifications.json` does.

### 7.4 Transport
- Suggesting is **not** a change: it writes nothing in the library and does not go in the tray.
- New route: `POST /api/v1/suggest`, body `{ skill, main }`, one clash per request. It gets the same origin, header and JSON checks as change routes, because it costs a model call on the owner's account.
- **One request returns every suggestion for that clash:** `{ suggestions: [{ source, name, description, difference, by }] }`, one per distinct differing copy (see 8). Within a request, the copies are asked one after another, and names already suggested are added to `taken`, so two copies never get the same name.
- **Workers (my call):** suggestions run in a pool of **two** `Reader` instances with `suggest-worker.js` and `timeoutMs` = 150 s × the number of copies + 10 s. A `Reader` runs one job at a time and rejects a second as busy, so the server sends each request to whichever instance is idle, and answers `BUSY` (retryable) when both are working. The page never sends more than two at once, so it does not hit `BUSY` in normal use. A long suggestion run never holds the write worker that Apply uses.
- The page shows progress by clash ("12 of 30 clashes suggested").

## 8. Changes the owner can apply

**`library.keep`** (new), with args `{ skill, main, keep: [{ source, name, description }] }`.

**Which copies need a rule (my call):** copies are grouped by content digest, and every **distinct content other than the main's** needs exactly one rule.
- Copies identical to the main need nothing; they collapse, as today.
- When two non-main copies are identical to each other (B = C ≠ A), one rule covers both. Its `from.source` is the one higher in the source order, and the preview says "B and C are the same; kept once as …".
- **No partial keep.** A clash ends either with every distinct content kept (`library.keep`) or with one copy (`library.prefer`, "Keep only one"). Nothing in between needs storing, and "resolved" has one definition: every distinct content is the main or the source of a rule.

**`describe()`** re-reads the clash, then:
- checks that `main` and every `keep[].source` are candidates of that clash;
- checks that every distinct non-main content has exactly one entry in `keep`, and refuses with a line naming the copy that is missing one;
- validates names (pattern, unique against the view, against other rules and against other `keep` entries) and descriptions;
- records each original's current digest.

**Preview lines:**
- "Your vault's `brainstorming` keeps the name `brainstorming`."
- "obra-superpowers' `brainstorming` is kept as `brainstorming-design-gate`."
- "Agents in N projects will see 1 more skill."
- When the listing budget is already over: "The listing is already over its budget; one more description makes that slightly worse." This is a warning, not a conflict.

**`run()`:**
- Writes the `preferences` entry for `main`, pinned to the current digests as `library.prefer` does.
- Upserts one `kept` rule per keep, replacing any rule with the same `from`.
- The store queues `library.rebuild` after it, as `prefer` does.

**Refusal at apply time:** if a digest differs from the one recorded at describe time ("changed since you looked"), or a name is taken by then.

**Other kinds:**
- **`library.unkeep`** (new), args `{ name }`. It removes one rule. The preview says plainly that agents lose that copy after the rebuild.
- **`library.rekeep`** (new), args `{ name, description? }`. It re-pins the rule's digest to the current original, optionally with a new description. It **also** re-pins the digests stored with that clash's main choice in `preferences`, so one change to an original clears its one Need a look row. Need a look shows a clash with kept copies as **one** row per changed copy, never a second "your choice changed" row for the same change.
- **"Keep only one"** stays the existing `library.prefer`.

All three join `KINDS` in `write-service.js` and the change-kind ordering in `store.ts`.

## 9. Screens

### 9.1 Name clashes becomes a queue
The `collisions` view in `library.ts` replaces the plain table with one row per clash that still needs deciding. Identical copies and resolved clashes are hidden behind a "Show resolved (n)" toggle.

```
Name clashes                          [Suggest names for 3]   3 to decide · 0 resolved
──────────────────────────────────────────────────────────────────────────────────
brainstorming                        2 copies differ · 41 lines, 1 extra file  [Compare]
  (●) Your vault          keeps the name  brainstorming
  ( ) obra-superpowers    keep as  [brainstorming-design-gate          ]  suggested by Claude
                          [Use before any creative work when you want a … ]
                          Differs: adds a hard approval gate before any code
                                      [Approve]  [Keep only one]  [Skip]
```

- The radio picks the main copy. It defaults to today's winner. Changing it swaps which copies need names.
- Name and description are editable inputs, prefilled by a suggestion when one exists, and marked "suggested by Claude", "fallback suggestion" or "typed by you". Validation messages appear inline, using the same rules as `describe()`.
- **Approve** queues `library.keep` (and the rebuild) into the existing tray, and the row shows "Will be kept when you apply". **Keep only one** queues `library.prefer`. **Skip** collapses the row for this session only.
- **Suggest names for N** fetches suggestions for every undecided row that has none cached. Its confirmation says it sends N short questions to Claude on the owner's account and changes nothing.
- The compare page (`compare.ts`) gains the same "keep as" fields under each non-main card, so a single clash can be settled from there too.

### 9.2 Need a look
New rows join the existing stale choices:
- **Kept copy, original changed:** "`brainstorming-design-gate` was written for an older version of obra-superpowers' `brainstorming`." Actions: Suggest again, Keep the description (`library.rekeep`), Remove the copy (`library.unkeep`).
- **Original gone (`keptMissing`):** "obra-superpowers no longer has `brainstorming`; the copy is not in the library." Action: Remove the rule.
- **Name taken (`keptBlocked`):** "`brainstorming-design-gate` is now also a skill in <source>." Action: rename, which is `library.keep` with a new name.

### 9.3 Fleet
The library card's existing clash line counts resolved clashes as decided. No other Fleet changes.

## 10. Delivery in slices

Each slice ships and is usable on its own.

1. **Core and manual keep.** `kept` rules in config and `loadConfig`; `computeView`, including main-copy stability (6.4); `materializeKept` with the frontmatter writer; kept copies as catalogue skills (6.3); `library.keep`, `library.unkeep`, and the removal lines in "Keep only one"; the queue with name and description typed by hand. After this, nothing is lost and everything is reachable.
2. **Claude suggestions.** `suggest.js`, the `runTool` standard-input option, the suggest worker and route, the cache, the batch button and progress, and the fallback.
3. **Need a look for kept copies.** Stale, missing and blocked rows, and `library.rekeep`.
4. **Later: Have problems.** The same rule shape with a `fix` instead of a `rename` (for example, add the missing frontmatter), and Claude proposing the corrected frontmatter. Out of scope here.

## 11. Testing

- **Node (`tests/`):**
  - `computeView` with kept rules: found, stale, missing, blocked by a source name, blocked by another rule.
  - The frontmatter writer: byte preservation, block scalars, CRLF, quoting round-trip through `parseFrontmatter`.
  - `materializeKept`: staged swap, refusal on foreign content, links outside not followed.
  - `loadConfig` rejects a malformed `kept`.
  - `suggest.js` with an injected `run`: valid JSON; injection text in the skill body; invalid names; timeout leading to fallback; de-duplication.
  - `library.keep`, `library.unkeep` and `library.rekeep` preview, apply and refusals, including a digest change between preview and apply.
  - `repo sync` produces the same library as the dashboard rebuild.
- **Vitest (`store.spec.ts`):** queue state, the suggestion progress counter, and pending-change markers.
- **Playwright:** approve two clashes with edited names, apply once, and see both copies on the Skills page. The suggest route is stubbed, and no real model is called in tests.

## 12. Calls made in this design, for the owner to check

- `config.json` holds the rules, beside the existing `preferences`, so the CLI and dashboard share them.
- The kept copy's entry carries the original's source key, so set rules by source include it.
- The model is Sonnet by default, overridable in config. Verify uses Haiku, but naming quality matters more here.
- Suggestions run two at a time, in their own worker, and are cached by digest.
- A later source that brings the same name as a kept copy wins the name; the kept copy is reported, never silently replaced.
- Links that point outside a skill folder are not copied into kept copies.
- Kept copies are full skills in the dashboard catalogue, read from the generated folder (6.3).
- The plain name is pinned with a choice whenever a clash has kept copies. "Keep only one" removes that clash's kept copies and says so by name (6.4).
- There is no partial keep. Identical non-main copies share one rule (8).
- `library.rekeep` also clears the clash's own stale flag, so one change gives one row (8).
- Descriptions are written as folded block scalars, on one line, with no change to the shared parser. Missing frontmatter lines are inserted (6.2).
- Suggestions run in two worker instances, one clash per request, with progress counted by clash (7.4).

## 13. Left to the builder

- The exact Claude CLI flags that disable tools (confirm against the installed version) and the prompt wording.
- Whether `materializeKept` copies changed folders only or the whole set on each rebuild. Whole is simpler; incremental is faster.
- Component structure for the queue (a new `clash-queue.ts`, or inside `library.ts`), following existing Angular patterns.
- Styling, which follows the tokens in `styles.css` (see the UI review for the planned `pending` and `selected` tokens).
