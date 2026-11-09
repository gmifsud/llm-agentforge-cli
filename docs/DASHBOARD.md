# Agentforge dashboard

The dashboard is the interactive way to use Agentforge. It shows where your skills come from, what is in the library, and which agent in which project reads it, as one board with cables between them. Everything you can do on the command line for sources, the library and projects, you can do here, and every change is shown as a plain-language plan before anything on disk moves.

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

## The two pages

### Wiring

Three columns, left to right, in the order skills travel:

| Column | Shows | You can |
| :-- | :-- | :-- |
| **Sources** | Your vault (always first, never written to) and every attached folder or Git repository, with how many skills each has and its state | Attach a repository, fetch updates for a Git source, detach |
| **Library** | How many skills your agents can use, how many come from each source, and whether the library on disk matches what the sources would produce now | Build or rebuild it, choose which source wins when two have a skill with the same name, open the full skill list |
| **Projects** | Each project folder and, for each agent in it, what that agent actually reads | Add a project, wire agents, repoint an agent that reads the wrong folder, remove a project from the list |

The cables carry the state, and the same state is always written next to them in words:

| Cable | Meaning |
| :-- | :-- |
| Green | Live: this source feeds the library, or this agent reads the library |
| Amber, from your vault | The agent reads your vault directly and misses everything you attached |
| Short amber stub | The agent reads some other folder |
| Short red stub, dashed | The agent's link is broken |
| Dashed indigo | A change you queued but have not applied |
| Dashed grey | A source that is not available (missing, or a Git source not downloaded yet) |

Agents are named for what they are: Claude Code (`CLAUDE.md`, `.claude/skills`), Codex (`AGENTS.md`, `.codex/skills`), Cursor and others (`AGENTS.md`, `.agents/skills`), Gemini CLI (`GEMINI.md`, `.gemini/skills`).

On a narrow window, or zoomed in, the columns stack and the cables are hidden; every state is still in the text.

### Skills

Every skill found in every source, searchable and filterable by source. Switch between *Everything found*, *In the library*, and *Name clashes*. Select a skill to see where it comes from, read its `SKILL.md` as plain text, and, when another source has a skill with the same name, choose which one your agents get. Folders that were skipped while looking for skills, and why, are listed under the table.

## How changes work

Nothing you click writes to disk directly. Each action adds one or more steps to the **review sheet** at the bottom of the screen:

1. Click an action, for example *Attach a repository*. The sheet opens with the steps it needs, in pipeline order: sources first, then the library, then projects. Attaching a folder, for instance, queues *Attach* and *Rebuild the library*, because attached skills only reach your agents through the library.
2. Each step is checked against your folders and described in plain words: what will be written, linked, unlinked or deleted. Lines are colour-coded: green adds, red removes, indigo changes, amber needs your attention.
3. If a step cannot be made, it says why, and *Apply* is disabled until you remove it. A step that only depends on an earlier queued step (wiring a project to a library a queued rebuild will create) is not treated as blocked.
4. *Apply* runs the steps in order. Each one is planned again against the disk immediately before it runs, so a preview that went out of date cannot be applied blindly. If one step is refused or fails, the steps after it are not run.
5. The sheet shows what actually happened for each step, then the board refreshes.

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
npm run dashboard:e2e    # real browser: wiring, preview-without-write, attach, add, wire, repoint, refusals, zoom, focus
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
