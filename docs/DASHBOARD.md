# Agentforge dashboard

The dashboard is the interactive way to use Agentforge. It shows where your skills come from, what is in the library, and which agent in which project reads it, as searchable lists you can act on many at a time, and a cable map for one project or folder. Everything you can do on the command line for sources, the library and projects, you can do here, and every change is shown as a plain-language plan before anything on disk moves.

## Start it

Requires Node.js 24.15 or newer for the Angular build. The CLI itself still runs on Node 20.

```powershell
Set-Location D:\Repos\LLM\llm-agentforge-cli
npm --prefix dashboard/web ci --no-fund --no-audit   # first time only
npm run dashboard:build
npm run dashboard:start
```

Open the printed `http://127.0.0.1:<port>` address. Ctrl+C stops it. Options:

| Option | Effect |
| :-- | :-- |
| `--port <n>` | Use a fixed port instead of a random free one |
| `--project <folder>` | Show this folder in Projects for this session only (repeatable). Without any, the folder you start from is shown |
| `--vault <folder>` | Use this vault instead of the normal resolution |

Projects you add in the dashboard are remembered in `~/.agentforge/projects.json`, so you normally start it with no options.

## The pages

The dashboard is built for many sources and many projects. Lists you can search and filter come first, one item opens at a time in a side panel, and the cable map is drawn for one project or one folder at a time, so nothing becomes a tangle however much you manage.

### Fleet (the home page)

Everything you manage, in one place, top to bottom:

| Part | Shows | You can |
| :-- | :-- | :-- |
| **Library** | How many skills your agents can use and from which sources, whether the library on disk is up to date, how many skill descriptions fit the listing budget, skills with problems, and personal skills that hide a library skill | Build or rebuild the library, browse all skills. A second card appears when two sources have a skill with the same name: it counts the clashes that need a look and links to **Compare** |
| **Counts** | Sources, sources needing attention, sources not downloaded; projects, projects needing attention, projects with an agent the tool has not confirmed | Click a count to filter its list by it. Click it again, or **Clear**, to undo |
| **Search and layout** | One search box for both lists, and **Both**, **Sources**, **Projects** | Choose how much to show. The choice is remembered in the browser. At a narrow width the two lists stack |
| **Sources** | Your vault and every attached folder or Git repository, in priority order, with skills, state and revision | Open one, attach a repository, tick Git sources for a bulk action |
| **Projects** | Projects grouped under their folder. Each row has one status (the worst thing about its agents), a chip per wired agent, and when the tool last confirmed it | Open one, add a project, tick projects or whole folders |

Things to know:

- **Order matters, so sources are never sorted.** When two sources have the same skill, the higher one wins. *Up* and *Down* are disabled while a search or filter is active, because moving a source inside a partial list would reorder a view of the list, not the list.
- **Folders.** A project is grouped under its parent folder, headed by the last two parts of that folder. Two different folders that would share a heading are shown by their full path. A list of more than 30 projects starts collapsed; **Expand all** and **Collapse all** are above it. While you search or filter, every folder with a match is open, so a collapsed folder never hides a result.
- **Open one.** Click a name to open it in the side panel. For a source: kind, path, state, revision, its place in the order with *Move up* and *Move down*, *Show its skills*, *Fetch updates* (Git sources) and *Detach*. For a project: each agent's state, its instruction file, how to call a skill in that tool, the fix that applies (*Repoint*, *Copy instead*, *Refresh copy*, *Verify*), *Wire agents*, *Show wiring*, and *Remove from list* for projects you added. Esc or *Close details* returns focus to the row you came from; on a narrow screen the panel takes the place of the lists.
- **Several at once.** Tick Git sources or projects (a folder's box ticks every project in it, a table header's box ticks everything showing). A bar shows what is selected with **Fetch selected** and **Verify selected**. Fetching queues one fetch per Git source and a single rebuild. Verifying queues one check for each working agent the tool has not confirmed, or confirmed before the skills changed, and sends one short question per agent, on your account, only when you apply. Both only queue changes for review, and work already in the review sheet is not counted twice. Selections you cannot currently see (filtered away, or in a list the layout hides) are counted as "not showing", so a bulk action never touches something out of sight without saying so.

- **Everything at once.** Under the counts, **Fetch all updates (n)** queues every Git source plus one rebuild, and **Check all agents (n)** queues a check for every working agent the tool has not confirmed. Each is one list in the review sheet, and the count is exact: anything already waiting is not counted again. A source or an agent that fails does not stop the others. When a rebuild is waiting in the review sheet, it offers to add checks for the agents that read the library through a link, since a rebuild changes what they see. The same two jobs on the command line are `agentforge update` and `agentforge check`.

Agents are named for what they are: Claude Code (`CLAUDE.md`, `.claude/skills`), Codex (`AGENTS.md`, `.codex/skills`), Cursor and others (`AGENTS.md`, `.agents/skills`), Gemini CLI (`GEMINI.md`, `.gemini/skills`).

### Wiring map

How skills travel, drawn as cables: **Sources**, then the **Library**, then **Projects**. It has no menu entry. It draws **one project or one folder at a time**: open it from *Show wiring* in a project's panel, or the *Show wiring* link on a folder heading in Fleet. A folder is shown ten projects at a time, in name order, with *Previous 10* and *Next 10*. Without a choice it draws nothing and links back to Fleet; if what you chose is no longer in your list it says so.

| Cable | Meaning |
| :-- | :-- |
| Green | Live: this source feeds the library, or this agent reads the library |
| Amber, from your vault | The agent reads your vault directly and misses everything you attached |
| Short amber stub | The agent reads some other folder |
| Short red stub, dashed | The agent's link is broken |
| Dashed indigo | A change you queued but have not applied |
| Dashed grey | A source that is not available (missing, or a Git source not downloaded yet) |

The same state is always written next to the cables in words. Repoint, copy, verify and wire work here exactly as in the panel, and each queues a change in the review sheet. On a narrow window, or zoomed in, the columns stack and the cables are hidden.

The map's address is `/map?project=<id>` or `/map?group=<folder>&page=<n>`; a page outside the folder is brought back inside it. `/fleet`, the address the fleet view was first shown at, still arrives at the home page.

### Skills

Every skill found in every source, searchable and filterable by source. Switch between *Everything found*, *In the library*, *Name clashes*, *Need a look* and *Have problems*. Select a skill to see where it comes from, why it is or is not what your agents get, read its `SKILL.md` as plain text, and, when another source has a skill with the same name, compare the copies and choose which one your agents get. Folders that were skipped while looking for skills, and why, are listed under the table.

## How changes work

Nothing you click writes to disk directly. Each action adds one or more steps to the **review sheet** at the bottom of the screen:

1. Click an action, for example *Attach a repository*. The sheet opens with the steps it needs, in pipeline order: sources first, then the library, then projects. Attaching a folder, for instance, queues *Attach* and *Rebuild the library*, because attached skills only reach your agents through the library.
2. Each step is checked against your folders and described in plain words: what will be written, linked, unlinked or deleted. Lines are colour-coded: green adds, red removes, indigo changes, amber needs your attention.
3. If a step cannot be made, it says why, and *Apply* is disabled until you remove it. A step that only depends on an earlier queued step (wiring a project to a library a queued rebuild will create) is not treated as blocked.
4. *Apply* runs the steps in order, one at a time, and shows how many are done. Each one is planned again against the disk immediately before it runs, so a preview that went out of date cannot be applied blindly. If a step is refused or fails, the steps after it are not run. The exception is a fetch or a check of an agent: one of those that fails never stops the others, so a repository that cannot be reached does not cancel the rest, and the library is still rebuilt from what is on disk. Steps run one request each so a long list of checks, each of which can take a while, stays inside the server's time limit.
5. The sheet shows what actually happened for each step, then the page refreshes.

| Action | What it does | What it never does |
| :-- | :-- | :-- |
| Attach a folder | Registers it in `repos.json`; reads it in place | Write into the folder |
| Attach a Git URL | Registers it, then downloads it into `~/.agentforge/repos/<name>` | Run Git hooks or submodules |
| Fetch updates | Fast-forwards Git sources | Change the library until it is rebuilt |
| Detach | Unregisters; deletes the downloaded copy of a Git source | Delete a folder source |
| Rebuild the library | Rebuilds `~/.agentforge/merged-skills` in a staging folder and swaps it in | Leave a half-built library if it fails |
| Choose a winner | Saves `preferences` in `~/.agentforge/config.json`; `agentforge repo sync` honours it too | Rename or edit either skill |
| Add / remove a project | Edits `~/.agentforge/projects.json` | Touch the project folder |
| Wire agents | Writes missing instruction files, links `<agent>/skills` to the library, adds that link to `.gitignore` | Overwrite an existing instruction file, or merge into a folder linked elsewhere |
| Repoint | Removes the old link and links to the library | Touch the folder the old link pointed at |

The dashboard wires projects to the **library**, never directly to your vault, so attached sources and your collision choices always reach your agents. Use the command line if you deliberately want a vault-only link.

## Local boundary

- The server listens on `127.0.0.1` only. Page and API share one origin, with exact Host and Origin checks and no CORS.
- Reads are `GET` with a custom header. Changes are `POST` to exactly two routes, `/api/v1/changes/preview` and `/api/v1/changes/apply`, and additionally require an exact `Origin`, a second custom header, `application/json`, no query string and a body under 64 KiB. Any other method or route is refused.
- Folder paths typed in the dashboard must be absolute local paths. Network shares and WSL paths are refused, including through links. Everything else is addressed by IDs from the current session.
- Reads run in one worker with a 15-second deadline. Changes run in a second worker, one job at a time, with a 3-minute deadline so a Git download can finish. Neither queues work without limit.
- `SKILL.md` is shown as escaped text; scripts and remote images in it are never executed or loaded. Documents over 1 MiB, symbolic-link files and paths escaping their source are refused.
- No telemetry, file watcher or background job. State lives in the files listed above and in memory.

## Validation

From the repository root:

```powershell
npm test                 # core + server, including the write paths
npm run dashboard:test   # client state, tray ordering, apply flow
npm run dashboard:build
npm run dashboard:e2e    # real browser: Fleet at 150 projects, side panel, bulk actions, scoped map, preview-without-write, repoint, verify, refusals, zoom, focus
git diff --check
```

Browser tests use headless Microsoft Edge on Windows. Set `AGENTFORGE_BROWSER_CHANNEL` to use another installed channel. Every test builds its own temporary vault, sources, registry and projects, and checks that previews change nothing on disk and that repointing leaves the old target untouched.

## Development

```powershell
# Terminal 1: server on a fixed port, allowing the dev origin
npm run dashboard:start -- --port 4311 --dev-origin http://127.0.0.1:4200

# Terminal 2: Angular dev server, proxying /api to it
npm --prefix dashboard/web start
```

Open `http://127.0.0.1:4200`. To try changes without touching your real setup, start the server with `USERPROFILE` pointing at an empty folder; everything it writes then goes there.

## Troubleshooting

| You see | Meaning and fix |
| :-- | :-- |
| *Dashboard assets are missing* | Run `npm run dashboard:build` |
| *The dashboard server is not responding* | The terminal running `dashboard:start` was closed. Start it again and refresh |
| A source says *Not downloaded yet* | Use *Fetch updates* on it |
| Library says *Out of date* | Sources changed since the last build. *Rebuild the library* |
| Library says *Cannot compare right now* | A source is missing or unreadable, so the dashboard will not guess what the library should hold |
| An agent *Reads your vault only* | It was linked by an older setup. *Repoint* links it to the library |
| *…points somewhere else. Use Repoint* | The agent's skills folder links to another folder. Repoint if that is not deliberate |
| *Changes must come from this dashboard page* | A request came from another page or tool. Only the dashboard's own page can make changes |
| A skill you expected is missing | Open Skills and expand *folders were skipped*. Links inside a source are never followed, so a skill that is itself a link is skipped |
