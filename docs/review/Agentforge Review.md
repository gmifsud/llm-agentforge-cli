llm-agentforge-cli · review of 21 Nov 2026 · commit e9ebe49

# Agentforge review

Two passes over the same repository: technical debt in the core and the dashboard server, then an audit of the dashboard's interface and its design tokens, done against the running app.

[Verdict](#verdict) [Technical debt](#debt) [Remediation plan](#plan) [Interface findings](#ui) [Design tokens](#tokens) [Token migration](#migration)

Summary

## Verdict

Architecture: solid

The core is cleanly layered (domain, application, infra, deployment) with a CLI that only formats. Planning only reads; applying re-checks every precondition before it acts. All 170 Node tests pass.

- Environment is injected, so the whole CLI runs against a temp home in tests.
- Fails closed on a corrupt registry; git runs without a shell and with hooks off.
- The dashboard server checks origin and headers, refuses network paths, and runs reads and writes in workers.

Interface: works, reads as noisy

The dashboard has a real colour vocabulary and good accessibility habits. What makes it feel off is how those colours are spent: the accent and the warning colour appear almost everywhere, and the Projects table is squeezed until words break mid-name.

- Orange means about nine different things.
- Yellow is on nearly every project row, so it no longer stands out.
- Spacing, radius and breakpoints have no scale; the single stylesheet has grown one feature at a time.

Part 1

## Technical debt, by priority

Priority = (Impact + Risk) × (6 − Effort), each scored 1–5. Highest first.

| # | Item | Type | I | R | E | Priority |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | **No CI**There is no `.github/`. The 170 Node tests, the Angular unit tests and the Playwright tests only run on your machine. | Infrastructure | 3 | 4 | 1 | **35** |
| 2 | **The dashboard parses the core's sentences**`humanNote` and `humanConflict` in `dashboard/server/write-service.js` rewrite text from `plan.js` with regexes. Rewording a CLI message silently breaks the dashboard's translation or how it classifies a conflict. | Architecture | 4 | 4 | 2 | **32** |
| 3 | **A personal path is the default vault**`D:\Repos\LLM\llm-skill-vault\skills` is hard-coded in `src/infra/paths.js`. On any other machine the tool falls back to a folder that does not exist. | Code | 2 | 3 | 1 | **25** |
| 4 | **The repo's own CLAUDE.md is a blank template**It is untracked and still says `Stack: <fill in>`, points at a non-existent `src/index.ts`, and has no build commands. | Documentation | 3 | 2 | 1 | **25** |
| 5 | **Core files written from the dashboard; constants copied**`saveConfig` for the core's `config.json` lives in the dashboard. The copy-marker file name is retyped instead of imported. `nameKey` exists three times, `IS_WIN` twice. | Architecture | 3 | 3 | 2 | **24** |
| 6 | **The library is computed in six places**The same `computeView({…})` call appears twice in `sync.js` (where `syncView` repeats `computeLibrary`), three times in the write service and once in the read service. Set budget logic is also in both the CLI and the dashboard. | Code | 3 | 2 | 2 | **20** |
| 7 | **config.json is not checked when loaded**Unlike the registry, any object is accepted; a mistyped `preferences` or `sourcePriority` fails deep inside view building. | Code | 2 | 3 | 2 | **20** |
| 8 | **Path-safety checks live in the read service**`localPath` and `contained` are imported from `read-service.js` by the write service, the HTTP layer and the launcher; write validation errors are raised as `ReadError`. | Code | 2 | 2 | 1 | **20** |
| 9 | **Node version mismatch**The root says `node >=20`, but `npm test` passes a glob to `node --test`, which needs Node 21. The dashboard requires `^24.15`. | Dependency | 2 | 2 | 1 | **20** |
| 10 | **Lost updates between CLI and dashboard**Both read, modify and rewrite `config.json` and `verifications.json` with no version check. Atomic rename stops corruption, not a lost change. | Architecture | 2 | 3 | 3 | **15** |
| 11 | **No type checking on the JavaScript core**`dashboard/contracts.d.ts` exists, but nothing checks the core against it. `// @ts-check` with `tsc --checkJs` would catch shape drift. | Test | 3 | 2 | 3 | **15** |
| 12 | **CLI marks skipped work as done**`cmdProject` prints ✓ for every action even when some entries were skipped; `void applied` is dead code. | Code | 1 | 1 | 1 | **10** |
| 13 | **One large write service**528 lines and 15 change kinds behind dynamic dispatch. Fine today; split by kind when it reaches about 20. | Code | 2 | 1 | 3 | **9** |

Items 2, 5 and 6 share one cause: the dashboard became a second client of a core that was shaped for the CLI. In each case the fix moves the shared piece (codes, file ownership, the library computation) down into `src/`.

Part 1

## Remediation plan

Each phase fits alongside feature work.

Phase 1 · under a day

### Quick wins

- GitHub Actions on Windows and Ubuntu: `npm test`, then the dashboard tests (#1).
- Raise `engines` to `>=22` (#9).
- Drop the personal default path; refuse with a clear "set --vault" message (#3).
- Fill in and commit this repo's `CLAUDE.md` (#4).

Phase 2 · 2–3 days

### Tighten the core–dashboard contract

- Plans emit coded notes and conflicts, such as `DOC_EXISTS` and `LINK_ELSEWHERE`; each client words them (#2).
- Move `saveConfig`, case folding and the marker name into `src/infra`; move path safety into `boundary.js` (#5, #8).
- Check the shape of `config.json` when it is loaded, as the registry already is (#7).

Phase 3 · as you touch the area

### Consolidate use cases

- One entry point for computing the library; set budgets move into `application/sets` (#6).
- Compare-and-swap on config and verification writes (#10).
- Turn on `@ts-check`, starting with `domain` and `deployment` (#11).

Part 2

## Interface findings

Observed in the built dashboard (Fleet, Skills and Sets pages) at 1440 × 900 and at a narrow pane, with a real workspace of 9 sources, 395 skills and 7 projects. The red stripe marks what most affects how the app feels.

U1

### Orange means too many things

SeenThe stylesheet says orange (`--planned`) means "your action". In practice it marks the active nav tab, selected table rows, pressed filter buttons, pressed chips, links, the focus ring, text selection, queued changes, ghost modules and "Why this matters".

EffectYou cannot tell at a glance whether something is selected, queued for change, or just a link. The one colour meant to say "this will change" is spent on navigation.

FixKeep orange for interactive things and queued changes (dashed for queued). Draw selection and the active tab in neutrals: a raised surface with an ink edge or an underline.

U2

### Yellow is on nearly every project row

SeenEach project row shows a yellow multi-line status pill, several yellow agent chips and a "needs attention" badge on its folder group; the summary strip adds "6 projects need attention".

EffectWhen 6 of 7 projects are yellow, yellow stops pointing at anything. The page reads as a wall of warnings rather than a list of things to do.

FixOne status per row: the worst one, as a short pill. Agent chips stay neutral, with a small coloured dot only on the agent that has the problem. Keep the full sentence for the detail panel.

U3

### The Projects table is squeezed until words break

SeenWith both lists side by side, Projects gets 1.2 fractions of the width. Names break mid-word ("SFAPlusReactNativ / e"), status pills wrap to three lines, agent chips stack three rows deep, and short git hashes split ("c1c8a8 / c").

Cause`td { overflow-wrap: anywhere }` in `styles.css` lets every cell break between any two letters, and the layout gives two dense tables the same row.

FixUse `overflow-wrap: break-word` on cells and `white-space: nowrap` on hashes, pills and chips. Stack Sources above Projects by default, or summarise the chips as "4 agents · 2 need a copy".

U4

### The library card has five actions and no clear first one

SeenShow, Show and set aside, Create a set, Rebuild the library and Browse all skills use four different button styles (tiny quiet, quiet, quiet with two-line wrap, orange link). None is the primary.

FixMake Rebuild the card's one primary action. Turn the problem rows into disclosure rows with the action on the right, all in one tiny style.

U5

### The source mix bar uses greys nobody can tell apart

SeenNine sources are drawn with six shades of slate (`--mix-0` to `--mix-5`), so the legend cannot be matched to the bar, and sources after the sixth reuse a colour.

FixShow the vault plus the two largest sources, then "6 others". Or drop the bar and list sources sorted by count.

U6

### Eighteen Up and Down buttons on the Sources table

FixAdd a "Change order" mode that shows the controls only while you reorder, or a drag handle that also works with the keyboard.

U7

### Switching tabs during the first load shows an error

SeenMoving between Fleet, Skills and Sets while the first read was running left a red "Another local read is running. Try again." banner and an empty page that only offers Refresh.

FixLet the store reuse the read already running instead of starting a second one, and show a loading layout instead of an empty page.

U8

### The same number differs between pages

SeenFleet says "About 120 of 395 descriptions fit". Sets says "About 120 of 370" for the whole library. Probably two different counts (skills against distinct descriptions), but the page does not say which.

FixUse one count and one wording on both pages, or label the difference.

U9

### A lot of small grey text

SeenThe base size is 14px, and 12px (`--s-1`) is used 24 times, mostly muted grey on near-black. Contrast passes, but the dense pages tire the eye.

FixRaise the base to 15px and the smallest size to 13px. Keep muted grey for secondary labels only, not for sentences you need to read.

Part 2

## Design tokens: what exists and what is missing

The colour layer is better than most: tokens are named by meaning (`live`, `caution`, `fault`, `planned`), and each has a tint. Everything else is written out by hand.

**1**stylesheet of 533 lines; no component has its own styles

**25**colour tokens, plus 5 colours written out by hand

**40+**distinct `rem` values for spacing, with no scale

**7**border radii: 0, 2, 3, 4, 12px, 999px and 50%

**4**breakpoints: 1080, 900 and 760 (container) and 640 (media)

**8**inline `style=` attributes in `sets.ts` and `set-editor.html`

The stylesheet repeats rules. `.segmented` and `.fleet tr.selected td` are each declared twice. Select boxes are styled three times. The 16px checkbox rule appears five times. `color-mix(var(--panel) 55%, var(--module))` is written three times and should be a token. The newest sections are labelled by task number (for example "T31"), which shows how the file grew.

### Primitive tokens (keep the values; give them names)

| Category | Token | Value | Source today |
| --- | --- | --- | --- |
| Slate | slate-950 … slate-100 |  | `--field`, `--panel`, `--module`, `--raised`, `--rule`, `--rule-strong`, `--muted`, `--ink` |
| Orange | orange-500 / 400 / 950 |  | `--planned`, the hover literal `#ffa966`, `--planned-tint` |
| Green, yellow, red | green-400 · yellow-400 · red-400 (+ 950 tints) |  | `--live`, `--caution`, `--fault` |
| Space | space-1 … space-8 | 4 · 8 · 12 · 16 · 20 · 24 · 32 · 48 px | Replaces the 40+ hand-written `rem` values |
| Radius | radius-sm · radius-pill | 3px · 999px | Replaces 0, 2, 4 and 12px (keep 50% for jacks) |
| Type | text-xs … text-xl | 13 · 15 · 17 · 20 · 26 px | Today `--s-1` to `--s3` = 12, 13, 15, 19, 24; raise by one step |
| Breakpoint | bp-narrow · bp-medium | 760 · 1080 px | Folds 900 into 1080 and 640 into 760 |

### Semantic tokens (one meaning each)

| Token | Maps to | Use it for | Replaces |
| --- | --- | --- | --- |
| surface-page / surface-raised / surface-hover / surface-well / surface-banded | slate-900 / 800 / 750 / 950 / mix | Page, modules, hover, inputs, vault and group rows | `--panel`, `--module`, `--raised`, `--field`, the three `color-mix` calls |
| text-primary / text-secondary / text-on-accent | slate-100 / slate-400 / orange-ink | Body text, labels, text on an orange fill | `--ink`, `--muted`, `--on-accent` |
| border-subtle / border-strong | slate-700 / slate-600 | Hairlines and control outlines | `--rule`, `--rule-strong` |
| interactive / interactive-hover / focus-ring | orange-500 / orange-400 / orange-500 | Buttons, links, focus | Part of `--planned`; the `#ffa966` literal |
| pending / pending-tint | orange-500 / orange-950 | **Only** queued changes, ghost rows, the change tray | The other half of `--planned` |
| selected-bg / selected-edge | slate-750 / slate-100 | Selected rows, active tab, pressed filters (new and neutral; fixes U1) | Today drawn with `--planned-tint` |
| status-ok / status-warn / status-error (+ tint) | green / yellow / red | State only, one per row (fixes U2) | `--live`, `--caution`, `--fault` |
| overlay-scrim / shadow-dialog | black at 67% / 0 16px 80px black at 56% | The review dialog | The `#000a` and `#0009` literals |

### Component tokens (the few that repeat)

| Component | Tokens | Why it needs them |
| --- | --- | --- |
| Button | button-primary-bg, button-quiet-border, button-pad, button-pad-tiny, button-radius | `button` and `a.button` repeat the same padding and border separately |
| Surface | panel-bg, panel-border, panel-pad | `.module`, `.list`, `.inspector`, `.card`, `.findings` and `.choosebox` each set their own padding: 1rem, 1.1rem, .7rem .8rem, .8rem |
| Pill / chip | pill-radius, pill-pad, chip-radius | `.pill` uses 12px, `.chip` 999px, `.agent-chip` 3px |
| Control | control-pad, control-border, control-bg, check-size | Inputs and selects are styled three times; the checkbox rule five times |
| Table | cell-pad, row-selected-bg, row-hover-bg | Cells use .4rem .5rem, .45rem .5rem and .55rem .6rem in different tables |

### Themes

The app is dark-only by choice, and the stylesheet says so. Keep that, but define every colour through the semantic layer so a light theme becomes a second block of values instead of a rewrite. Add a `@media (forced-colors: active)` block so the cables, jacks and status pills keep a visible outline in Windows High Contrast. A cross-platform token pipeline such as Style Dictionary is not worth it here: there is one web client, so plain CSS custom properties are the source of truth.

Part 2

## Token migration plan

No big-bang rewrite. Each step ships on its own and is covered by the existing Playwright tests, which already check text-colour contrast pairs.

```
dashboard/web/src/
  styles.css              ← becomes a list of @imports
  styles/
    tokens.primitives.css slate, orange, status ramps; space, radius, type, breakpoints
    tokens.semantic.css   surface-*, text-*, interactive, pending, selected, status-*
    base.css              reset, typography, focus, links
    controls.css          button, a.button, input, select, checkbox, segmented, chip, pill
    layout.css            masthead, main, bay, split, fleet-shell, drawer
    tables.css            table, row states, group rows
    tray.css              change strip and review dialog
  app/*.ts                inline style= attributes move to classes
```

1. **Name what exists.** Add the primitive and semantic layers with today's values, so nothing changes on screen. Replace the five hand-written colours and the three `color-mix` calls.
2. **Split `--planned`.** Introduce `interactive`, `pending` and the neutral `selected-*` tokens, then move the nav, rows, filters and chips to `selected-*`. This is the change you will notice most (U1).
3. **One status per row.** Rework the project rows and agent chips around the worst status, and fix the cell wrapping (U2, U3). Change `td` to `overflow-wrap: break-word`.
4. **Space, radius and type scales.** Replace the `rem` literals section by section, collapse radii to two, raise the type scale by one step (U9).
5. **Split the file** into the folders above, and remove the duplicate rules and inline styles as each part moves.
6. **Component fixes:** one primary action on the library card (U4), the mix bar (U5), a reorder mode (U6), reuse of the running read (U7), one skill count (U8).

Prepared from a read of the source at commit e9ebe49 and a session with the built dashboard on 21 Nov 2026. The test suite passed: 170 of 170.