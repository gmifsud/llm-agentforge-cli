# Agent Forge read-only dashboard

M1 provides Sources, Skills and Projects over the existing local Agent Forge data. It cannot add/remove sources, fetch Git updates, rebuild the merged view, edit files or apply project changes. Online discovery is deferred.

## Build and run (Windows PowerShell)

The CLI remains dependency-free and supports its existing Node versions. The separate Angular package requires Node 24.15+ within the Node 24 release line; validation used Node 24.22.1.

```powershell
Set-Location D:\Repos\LLM\llm-agentforge-cli
npm --prefix dashboard/web ci --no-fund --no-audit
npm run dashboard:build
npm run dashboard:start -- --project D:\Repos\LLM\llm-agentforge-cli --project D:\Repos\Tools\gd-tool-harness
```

Open the printed `http://127.0.0.1:<port>` URL. Ctrl+C stops the server and worker. The port is ephemeral unless `--port <number>` is supplied. No browser is opened automatically. Project paths are supplied at startup; no registry is written. Without `--project`, the startup working directory is inspected. `--vault <folder>` overrides the normal Agent Forge resolution.

Pinned dependencies are recorded in `dashboard/web/package-lock.json`: Angular 22.0.8, CLI/build 22.0.9, TypeScript 6.0.3, RxJS 7.8.2. Use the lockfile rather than floating latest versions. Generated `dist`, `.angular`, test reports and `node_modules` are ignored.

## Views and meaning

1. **Sources:** primary vault plus registered sources, local availability/revision, discovered counts and rejections. A missing/unfetched source has an unknown count, not zero. No registry is a valid empty external-source list.
2. **Skills:** all discovered candidates, a default merged preview and name collisions. Search/filter/paging are local to the loaded catalogue. Select a row, then Read full SKILL.md to display escaped plain text. Text and paths are observed locally; no scripts or remote images are executed.
3. **Projects:** choose a startup-configured folder, then Inspect project. Document presence, link health and library match are separate. A working link to a different library is labelled `differs`; runtime compatibility is not inferred.

Refresh rescans local data, never Git remotes. The merged preview is what current sources would produce under the core's default rules; it is not the materialized view or an applied revision. If any source is unavailable, inventory is partial and merge preview is unavailable. External edits can occur between scan and document read; timestamps identify each observation. A failed refresh keeps old rows visibly stale and pauses document reads until a successful refresh.

## Local boundary

- Node listens only on `127.0.0.1`. The built UI and API share an origin. Exact Host and Origin checks, cross-site rejection and a required `X-Agentforge-Read: 1` header apply to the API. There is no CORS allow-all or arbitrary command endpoint.
- Only GET/HEAD are supported; HEAD never starts a scan. Project and document requests use IDs from the session, not user-supplied file paths. Non-local Windows UNC/WSL paths are refused, including supported symlinks targeting them.
- Documents must be ordinary UTF-8 SKILL.md files contained in their discovered source. Symlinked files, escaping paths and files over 1 MiB are refused. Local link ancestry is checked afresh for document reads. The application is not a sandbox against a hostile process concurrently rewriting local filesystem state.
- Read jobs use one worker, one active job, a 15-second deadline and no unbounded queue. Simultaneous catalogue refreshes coalesce. Idle worker exit/error invalidates that worker so the next read can restart it. Catalogue size is limited to 5,000 candidates.
- Revision display uses contained ordinary-file reads of `.git/HEAD`, loose branch refs or `packed-refs`; no executable or Git config is loaded. HEAD/loose refs are limited to 4 KiB, packed refs to 1 MiB. Full SHA-1/SHA-256 values are displayed. Gitdir files, escaping metadata links, symbolic branch refs, unsupported ref formats and oversized metadata show an unavailable revision. This is metadata inspection, not object-database validation.
- Runtime state is memory-only. No file watcher, background refresh, telemetry, disk cache or persisted operation log is created. Browser and OS caches and development build outputs are outside the managed-file read-only guarantee.

## Validation

Run from the repository root:

```powershell
npm test
npm run dashboard:test
npm run dashboard:build
npm run dashboard:e2e
git diff --check
```

Browser tests use headless Microsoft Edge on Windows (already installed on the validated host). To use another installed Playwright channel, set `AGENTFORGE_BROWSER_CHANNEL`. Outside Windows, install the Playwright Chromium browser explicitly before browser tests; cross-platform runtime behavior has not been qualified by this Windows-local milestone.

Tests create isolated temporary vaults, registries, cached Git metadata and project links. They compare content hashes and link targets before/after reads, test same-origin and path refusals, verify core merge parity, recover from worker timeouts, and measure five warm reads of 1,000 external skills across ten sources. Browser tests cover the real built Angular app and Node adapter, external fixture edits, inert instruction text, narrow layout, keyboard focus and CSS zoom. Screenshots/traces are local ignored test outputs.

## Development

Use two terminals:

```powershell
# Terminal 1: fixed local adapter port; allow only the configured development origin.
npm run dashboard:start -- --port 4311 --dev-origin http://127.0.0.1:4200 --project D:\Repos\LLM\llm-agentforge-cli

# Terminal 2: Angular CLI, loopback only, proxying /api to the adapter.
npm --prefix dashboard/web start
```

Open `http://127.0.0.1:4200`. For normal use, prefer the single-origin production build. The development proxy and the production server do not support LAN clients.

## Troubleshooting

| Symptom | Meaning / action |
| --- | --- |
| Dashboard assets missing | Run `npm run dashboard:build` from the repository root. |
| Configuration could not be read | Inspect existing Agent Forge config/registry; the dashboard will not repair or overwrite them. |
| Source is rejected | Its path fails local-boundary or containment checks. Review the displayed source and fix it outside the dashboard if appropriate. |
| Merge preview unavailable | At least one source is missing, unfetched or unreadable. Inspect source state; no fetch is attempted. |
| Stale catalogue / file changed | Refresh and reselect the skill. External source changes are not pinned. |
| Read timed out / busy | Let the active read finish, then refresh. After timeout the worker restarts on the next request. |
| Unknown project | Restart with the intended `--project` path. |
| Non-local path refused | M1 is native Windows/local storage only; it does not traverse WSL or shares. |

The CLI remains the existing way to perform mutations. Review its effects separately: fetching a checkout can immediately affect projects linked to it. Dashboard M1 does not change that behavior.
