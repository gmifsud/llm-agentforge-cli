'use strict';
/**
 * Changes the dashboard can make. Each kind has one planner that returns a
 * plain-language description; apply() re-plans every change against the disk
 * at that moment, refuses if the fresh plan has conflicts, then executes it
 * through the core. A previewed plan is a description, never a permission.
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createPaths, loadConfig, loadRegistry, resolvePrimarySource } = require('../../src/infra/paths');
const { validateSourceId, deriveSourceId, isGitUrl } = require('../../src/domain/source-id');
const { TARGETS } = require('../../src/domain/targets');
const { AgentforgeError } = require('../../src/domain/errors');
const { addSource, removeSource, fetchSources, cacheRootFor, sourceRootFor } = require('../../src/application/sources');
const { syncView } = require('../../src/application/sync');
const { buildVars, planProject } = require('../../src/application/project');
const { applyPlan } = require('../../src/deployment/apply');
const { computeView } = require('../../src/deployment/build-view');
const { discoverSkills } = require('../../src/discovery/discover-skills');
const { createGit } = require('../../src/infra/git');
const { samePath, inspectDestination } = require('../../src/infra/fs-inspect');
const { localPath, contained } = require('./read-service');
const { ReadError, ERROR } = require('./constants');
const { nameKey, loadSavedProjects, saveSavedProjects, saveConfig, diffLibrary, saveVerification, skillsBasis } = require('./workspace');
const { verifyTarget, DEFAULT_TOOL, TOOLS } = require('../../src/application/verify');
const { createHash } = require('node:crypto');

const idFor = (...values) => createHash('sha256').update(JSON.stringify(values)).digest('hex');
const KINDS = ['source.attach', 'source.detach', 'source.fetch', 'library.prefer', 'library.order', 'library.rebuild', 'project.add', 'project.forget', 'project.wire', 'project.verify'];
const LINK_TYPES = ['auto', 'junction', 'symlink', 'copy'];
const list = (names, max = 6) => names.length <= max ? names.join(', ') : `${names.slice(0, max).join(', ')} and ${names.length - max} more`;
const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

function bad(message) { return new ReadError(ERROR.INVALID, message, 400); }
function str(value, field, { optional = false, max = 2048 } = {}) {
  if (value === undefined || value === null || value === '') { if (optional) return undefined; throw bad(`${field} is required.`); }
  if (typeof value !== 'string' || value.length > max || value.includes('\0')) throw bad(`${field} must be text.`);
  return value.trim();
}

class WriteService {
  constructor({ homedir = os.homedir(), projects = [process.cwd()], vault, env = process.env, git, verifyRun } = {}) {
    this.paths = createPaths({ homedir, scriptDir: path.resolve(__dirname, '../..') });
    this.env = { AGENTFORGE_VAULT_ROOT: env.AGENTFORGE_VAULT_ROOT };
    this.vault = vault;
    this.sessionProjects = projects.map(p => path.resolve(p));
    this.git = git || createGit();
    this.verifyRun = verifyRun;   // injected in tests; the real one runs the agent tool
  }

  // ─── shared state ──────────────────────────────────────────────────────────
  config() { contained(this.paths.homedir, this.paths.configJson); return loadConfig(this.paths); }
  registry() { contained(this.paths.homedir, this.paths.reposJson); return loadRegistry(this.paths).repositories; }
  primary(config = this.config()) { return resolvePrimarySource({ cliVault: this.vault, env: this.env, paths: this.paths, config }); }
  projects() {
    const saved = loadSavedProjects(this.paths).map(p => ({ path: path.resolve(p), origin: 'saved' }));
    const all = [...this.sessionProjects.map(p => ({ path: p, origin: 'session' })), ...saved];
    const seen = new Set();
    return all.filter(p => { const k = nameKey(p.path); if (seen.has(k)) return false; seen.add(k); return true; })
      .map(p => ({ ...p, id: idFor('project', p.path), name: path.basename(p.path) || p.path }));
  }
  project(id) {
    const p = this.projects().find(x => x.id === id);
    if (!p) throw new ReadError(ERROR.NOT_FOUND, 'That project is not in the list. Refresh and try again.', 404);
    localPath(p.path);
    return p;
  }
  view(config = this.config()) {
    const repos = this.registry();
    return computeView({ primaryRoot: this.primary(config), repos, cacheRootFor: r => cacheRootFor(this.paths, r), preferences: config.preferences || {}, sourcePriority: config.sourcePriority });
  }

  /** Validate the change shape, then dispatch. */
  describe(change) {
    if (!change || typeof change !== 'object' || !KINDS.includes(change.kind)) throw bad('Unknown change.');
    const args = change.args && typeof change.args === 'object' ? change.args : {};
    return this[change.kind.replace('.', '_')](args);
  }

  preview(change) {
    try { const d = this.describe(change); return { ...d, kind: change.kind, args: d.args }; }
    catch (e) { return { kind: change?.kind, title: 'This change cannot be made', lines: [], conflicts: [message(e)], ok: false }; }
  }

  apply(changes) {
    if (!Array.isArray(changes) || changes.length === 0 || changes.length > 50) throw bad('Send between 1 and 50 changes.');
    const results = [];
    let stopped = false;
    for (const change of changes) {
      if (stopped) { results.push({ kind: change?.kind, title: titleFor(change), status: 'skipped', lines: [], message: 'Not run because an earlier change did not apply.' }); continue; }
      let plan;
      try { plan = this.describe(change); } catch (e) { results.push({ kind: change?.kind, title: titleFor(change), status: 'refused', lines: [], message: message(e) }); stopped = true; continue; }
      if (!plan.ok) { results.push({ kind: change.kind, title: plan.title, status: 'refused', lines: plan.lines, message: plan.conflicts.join(' ') }); stopped = true; continue; }
      try {
        const outcome = plan.run();
        results.push({ kind: change.kind, title: plan.title, status: 'applied', lines: outcome?.lines || plan.lines, message: outcome?.message || '' });
        if (outcome?.failed) { results[results.length - 1].status = 'failed'; stopped = true; }
      } catch (e) {
        results.push({ kind: change.kind, title: plan.title, status: e instanceof AgentforgeError && e.exitCode === 3 ? 'refused' : 'failed', lines: plan.lines, message: message(e) });
        stopped = true;
      }
    }
    return { results };
  }

  // ─── sources ───────────────────────────────────────────────────────────────
  source_attach(args) {
    const location = str(args.location, 'Folder or Git URL');
    const branch = str(args.branch, 'Branch', { optional: true, max: 200 });
    const type = isGitUrl(location) ? 'git' : 'local';
    let resolved = location;
    const conflicts = [], lines = [];
    if (type === 'local') {
      if (!path.isAbsolute(location)) throw bad('Use the full folder path, for example D:\\Repos\\my-skills.');
      resolved = localPath(location);
      const st = inspectDestination(resolved);
      if (st.kind === 'missing') conflicts.push(`${resolved} does not exist.`);
      else if (st.kind === 'file') conflicts.push(`${resolved} is a file, not a folder.`);
      if (samePath(resolved, this.paths.mergedSkills)) conflicts.push('That folder is the library itself; it cannot also be a source.');
      if (samePath(resolved, this.primary())) conflicts.push('That folder is your vault; it is already the primary source.');
    }
    const name = str(args.name, 'Name', { optional: true, max: 64 }) || deriveSourceId(location);
    try { validateSourceId(name); } catch { conflicts.push(`"${name}" cannot be used as a name. Use letters, digits, "-", "_" or ".".`); }
    const clash = this.registry().find(r => r.name.toLowerCase() === name.toLowerCase());
    if (clash) conflicts.push(`A source called "${clash.name}" is already attached.`);
    if (type === 'local') {
      lines.push({ tone: 'add', text: `Attach the folder ${resolved} as "${name}"` });
      lines.push({ tone: 'note', text: 'The folder is read in place. Agentforge never writes into it.' });
      if (!conflicts.length) {
        const found = discoverSkills(resolved);
        lines.push({ tone: found.skills.length ? 'note' : 'warn', text: found.skills.length ? `${plural(found.skills.length, 'skill')} found in it` : 'No skills found in it (no folder with a SKILL.md)' });
        const existing = new Set(this.view().entries.map(e => nameKey(e.name)));
        const overlap = found.skills.filter(s => existing.has(nameKey(s.name))).map(s => s.name);
        if (overlap.length) lines.push({ tone: 'warn', text: `${plural(overlap.length, 'skill')} share a name with one you already have: ${list(overlap)}. The one already in the library stays there until you choose otherwise.` });
      }
    } else {
      lines.push({ tone: 'add', text: `Attach the Git repository ${location}${branch ? ` (branch ${branch})` : ''} as "${name}"` });
      lines.push({ tone: 'note', text: 'Its skills are counted after it is downloaded with Fetch updates.' });
    }
    return { title: `Attach ${name}`, lines, conflicts, ok: conflicts.length === 0, args: { location: resolved, name, branch },
      run: () => { addSource({ paths: this.paths, urlOrPath: resolved, name, branch }); } };
  }

  source_detach(args) {
    const name = str(args.name, 'Source', { max: 64 });
    const repo = this.registry().find(r => r.name === name);
    if (!repo) throw new ReadError(ERROR.NOT_FOUND, `No source called "${name}" is attached.`, 404);
    const lines = [{ tone: 'remove', text: `Detach "${name}"` }];
    if (repo.type === 'local') lines.push({ tone: 'note', text: `The folder ${repo.url_or_path} is left exactly as it is.` });
    else lines.push({ tone: 'remove', text: `Delete the downloaded copy in ${cacheRootFor(this.paths, repo)}` });
    const root = sourceRootFor(this.paths, repo);
    if (fs.existsSync(root)) {
      const leaving = this.view().entries.filter(e => e.source === name).map(e => e.name);
      if (leaving.length) lines.push({ tone: 'warn', text: `${plural(leaving.length, 'skill')} leave the library when it is rebuilt: ${list(leaving)}` });
    }
    return { title: `Detach ${name}`, lines, conflicts: [], ok: true, args: { name },
      run: () => { removeSource({ paths: this.paths, name }); } };
  }

  source_fetch(args) {
    const only = str(args.name, 'Source', { optional: true, max: 64 });
    const gits = this.registry().filter(r => r.type === 'git' && (!only || r.name === only));
    if (only && !gits.length) throw new ReadError(ERROR.NOT_FOUND, `No Git source called "${only}" is attached.`, 404);
    const lines = gits.map(r => ({ tone: 'change', text: fs.existsSync(cacheRootFor(this.paths, r)) ? `Update "${r.name}" from ${r.url_or_path}` : `Download "${r.name}" from ${r.url_or_path}` }));
    if (!gits.length) lines.push({ tone: 'note', text: 'No Git sources are attached. Folder sources are always read in place.' });
    lines.push({ tone: 'note', text: 'The library does not change until it is rebuilt.' });
    return { title: only ? `Fetch updates for ${only}` : 'Fetch updates', lines, conflicts: [], ok: true, args: { name: only },
      run: () => {
        const results = fetchSources({ paths: this.paths, git: this.git, only });
        const out = results.filter(r => r.status !== 'skipped').map(r => r.status === 'failed'
          ? { tone: 'warn', text: `"${r.name}" could not be fetched: ${r.error}` }
          : { tone: 'change', text: `"${r.name}" ${r.status === 'cloned' ? 'downloaded' : 'up to date'}${r.revision ? ` at ${r.revision}` : ''}` });
        return { lines: out, failed: results.some(r => r.status === 'failed') };
      } };
  }

  // ─── library ───────────────────────────────────────────────────────────────
  library_prefer(args) {
    const skill = str(args.skill, 'Skill', { max: 200 });
    const source = str(args.source, 'Source', { optional: true, max: 64 });
    const config = this.config();
    const clashOf = () => computeView({ primaryRoot: this.primary(config), repos: this.registry(), cacheRootFor: r => cacheRootFor(this.paths, r), preferences: {}, sourcePriority: config.sourcePriority })
      .clashes.find(c => nameKey(c.name) === nameKey(skill));
    const clash = clashOf();
    if (!clash) throw bad(`Only one source provides "${skill}", so there is nothing to choose.`);
    if (source && !clash.candidates.some(c => c.source === source)) throw bad(`"${source}" does not provide "${skill}".`);
    const label = s => (s === 'vault' ? 'your vault' : s);
    const lines = [source
      ? { tone: 'change', text: `Use the ${skill} from ${label(source)} in the library` }
      : { tone: 'change', text: `Go back to the source order for ${skill} (${label(clash.winner)} wins)` }];
    if (source) lines.push({ tone: 'note', text: 'Your choice is tied to the current content of each copy. If one of them changes later, you will be asked to look again.' });
    lines.push({ tone: 'note', text: 'Saved in ~/.agentforge/config.json. The command line uses the same choice.' });
    return { title: `Choose ${skill}`, lines, conflicts: [], ok: true, args: { skill, source },
      run: () => {
        const fresh = this.config();
        const prefs = { ...(fresh.preferences || {}) };
        for (const k of Object.keys(prefs)) if (nameKey(k) === nameKey(skill)) delete prefs[k];
        // Pin the choice to the content of every candidate as it is right now (re-read at apply time).
        const now = clashOf();
        if (source) prefs[skill] = { source, digests: Object.fromEntries((now ? now.candidates : []).map(c => [c.source, c.digest])), chosenAt: new Date().toISOString() };
        const next = { ...fresh, preferences: prefs };
        if (!Object.keys(prefs).length) delete next.preferences;
        saveConfig(this.paths, next);
      } };
  }

  /** Which source wins when two have the same skill. A per-skill choice still beats the order. */
  library_order(args) {
    const order = Array.isArray(args.order) ? args.order : null;
    if (!order || order.length > 200 || order.some(k => typeof k !== 'string' || !k || k.length > 64)) throw bad('Send the sources in the order you want.');
    const config = this.config();
    const repos = this.registry();
    const known = new Set(['vault', ...repos.map(r => r.name)]);
    const unknown = order.filter(k => !known.has(k));
    if (unknown.length) throw bad(`Not an attached source: ${list(unknown)}.`);
    if (new Set(order).size !== order.length) throw bad('A source appears twice in the order.');
    const label = s => (s === 'vault' ? 'your vault' : s);
    const viewWith = sourcePriority => computeView({ primaryRoot: this.primary(config), repos, cacheRootFor: r => cacheRootFor(this.paths, r), preferences: config.preferences || {}, sourcePriority });
    const before = new Map(viewWith(config.sourcePriority).entries.map(e => [nameKey(e.name), e.source]));
    const after = viewWith(order);
    const flips = after.entries.filter(e => before.has(nameKey(e.name)) && before.get(nameKey(e.name)) !== e.source);
    const lines = [{ tone: 'change', text: `Use this order when two sources have the same skill: ${after.order.map(label).join(', then ')}` }];
    if (flips.length) {
      const byWinner = new Map();
      for (const f of flips) byWinner.set(f.source, [...(byWinner.get(f.source) || []), f.name]);
      for (const [source, names] of byWinner) lines.push({ tone: 'change', text: `${plural(names.length, 'skill')} switch to ${label(source)}: ${list(names.sort())}` });
    } else lines.push({ tone: 'note', text: 'No skill changes hands with this order.' });
    if (after.order[0] !== 'vault') lines.push({ tone: 'warn', text: 'Your vault is no longer first. Where a source above it has the same skill, that source\'s version is used.' });
    const kept = after.clashes.filter(c => c.by === 'choice').length;
    if (kept) lines.push({ tone: 'note', text: `${plural(kept, 'skill')} you chose by hand keep your choice.` });
    lines.push({ tone: 'note', text: 'Saved in ~/.agentforge/config.json. The command line uses the same order.' });
    return { title: 'Set source order', lines, conflicts: [], ok: true, args: { order },
      run: () => { saveConfig(this.paths, { ...this.config(), sourcePriority: order }); } };
  }

  library_rebuild() {
    const config = this.config();
    const repos = this.registry();
    const view = this.view(config);
    contained(this.paths.homedir, this.paths.mergedSkills);
    const d = diffLibrary(this.paths.mergedSkills, view.entries);
    const lines = [], conflicts = [];
    const missing = repos.filter(r => !fs.existsSync(sourceRootFor(this.paths, r))).map(r => r.name);
    if (missing.length) lines.push({ tone: 'warn', text: `${list(missing)} ${missing.length === 1 ? 'is' : 'are'} not available yet, so ${missing.length === 1 ? 'its' : 'their'} skills will be missing. Fetch updates first.` });
    if (d.invalid) conflicts.push(`${this.paths.mergedSkills} is not a folder of links. Move it aside, then rebuild.`);
    if (!d.built) lines.push({ tone: 'add', text: `Create the library with ${plural(view.entries.length, 'skill')}` });
    else {
      if (d.add.length) lines.push({ tone: 'add', text: `Add ${plural(d.add.length, 'skill')}: ${list(d.add)}` });
      if (d.change.length) lines.push({ tone: 'change', text: `Switch ${plural(d.change.length, 'skill')} to another source: ${list(d.change)}` });
      if (d.remove.length) lines.push({ tone: 'remove', text: `Remove ${plural(d.remove.length, 'skill')}: ${list(d.remove)}` });
      if (d.inSync) lines.push({ tone: 'note', text: `Already up to date with ${plural(view.entries.length, 'skill')}` });
    }
    lines.push({ tone: 'note', text: 'Projects wired to the library see the result immediately.' });
    return { title: 'Rebuild the library', lines, conflicts, ok: conflicts.length === 0, args: {},
      run: () => {
        const res = syncView({ paths: this.paths, env: this.env, cliVault: this.vault, fetch: false, git: this.git });
        return { lines: [{ tone: 'add', text: `Library rebuilt with ${plural(res.linked, 'skill')}` }] };
      } };
  }

  // ─── projects ──────────────────────────────────────────────────────────────
  project_add(args) {
    const raw = str(args.path, 'Project folder');
    if (!path.isAbsolute(raw)) throw bad('Use the full folder path, for example D:\\Repos\\my-app.');
    const folder = localPath(raw);
    const conflicts = [];
    const st = inspectDestination(folder);
    if (st.kind === 'missing') conflicts.push(`${folder} does not exist.`);
    else if (st.kind === 'file') conflicts.push(`${folder} is a file, not a folder.`);
    if (this.projects().some(p => samePath(p.path, folder))) conflicts.push('That folder is already in the list.');
    const lines = [{ tone: 'add', text: `Add ${folder} to your projects` }, { tone: 'note', text: 'Nothing in the folder changes until you wire it.' }];
    return { title: `Add ${path.basename(folder) || folder}`, lines, conflicts, ok: conflicts.length === 0, args: { path: folder },
      run: () => { const saved = loadSavedProjects(this.paths); saved.push(folder); saveSavedProjects(this.paths, saved); } };
  }

  project_forget(args) {
    const p = this.projects().find(x => x.id === str(args.projectId, 'Project', { max: 64 }));
    if (!p) throw new ReadError(ERROR.NOT_FOUND, 'That project is not in the list.', 404);
    const conflicts = p.origin === 'session' ? ['This project was given with --project when the dashboard started. Restart without it to remove it.'] : [];
    return { title: `Remove ${p.name} from the list`, ok: !conflicts.length, conflicts, args: { projectId: p.id },
      lines: [{ tone: 'remove', text: `Stop showing ${p.path}` }, { tone: 'note', text: 'Nothing in the folder changes. Existing links stay as they are.' }],
      run: () => { saveSavedProjects(this.paths, loadSavedProjects(this.paths).filter(x => !samePath(x, p.path))); } };
  }

  /** Ask the agent tool itself whether it sees the wired skills. Writes nothing in the project. */
  project_verify(args) {
    const p = this.project(str(args.projectId, 'Project', { max: 64 }));
    const target = str(args.target, 'Agent', { max: 32 });
    if (!TARGETS[target]) throw bad(`Unknown agent "${target}".`);
    const tool = DEFAULT_TOOL[target];
    const who = TOOL_NAMES[tool] || tool;
    const dotDir = path.join(p.path, TARGETS[target].dir);
    const conflicts = [];
    const st = inspectDestination(path.join(dotDir, 'skills'));
    if (st.kind === 'missing') conflicts.push(`${TARGETS[target].dir}/skills does not exist yet. Wire the agent first.`);
    else if (st.kind === 'link' && st.broken) conflicts.push(`${TARGETS[target].dir}/skills is a broken link. Repoint it first.`);
    const lines = [{ tone: 'note', text: `Ask ${who} whether it sees the skills in ${p.name}` }];
    lines.push(TOOLS[tool].asks
      ? { tone: 'warn', text: `Sends one short question to ${who}, on your account with that tool. It is told not to read files or run commands.` }
      : { tone: 'note', text: `Runs ${who}'s own skill listing. No question is sent to a model.` });
    lines.push({ tone: 'note', text: 'Nothing in the project changes. The answer is saved so the board can show it.' });
    return { title: `Check ${who} in ${p.name}`, lines, conflicts, ok: conflicts.length === 0, args: { projectId: p.id, target },
      run: () => {
        const r = verifyTarget({ projectRoot: p.path, target, tool, ...(this.verifyRun ? { run: this.verifyRun } : {}) });
        saveVerification(this.paths, p.path, target, { level: r.level, tool: r.tool, detail: r.detail, at: new Date().toISOString(), basis: skillsBasis(dotDir) });
        const good = r.level === 'verified';
        const out = [{ tone: good ? 'add' : 'warn', text: good ? `${who} sees the skills: ${r.detail.replace(/^\S+ /, '')}` : `${who} did not confirm it: ${r.detail}` }];
        if (r.sampled.length) out.push({ tone: 'note', text: `Asked about: ${r.sampled.join(', ')}` });
        if (r.level === 'not-listed' && TARGETS[target].copyOnly !== true && tool === 'antigravity') out.push({ tone: 'note', text: 'Antigravity does not follow links. Give it a copy.' });
        return { lines: out, message: good ? '' : 'Checked; the tool did not confirm it sees the skills.' };
      } };
  }

  project_wire(args) {
    const p = this.project(str(args.projectId, 'Project', { max: 64 }));
    const targets = Array.isArray(args.targets) ? [...new Set(args.targets)] : [];
    if (!targets.length || targets.some(t => !TARGETS[t])) throw bad(`Choose at least one agent: ${Object.keys(TARGETS).join(', ')}.`);
    const link = args.link === undefined ? 'auto' : args.link;
    if (!LINK_TYPES.includes(link)) throw bad('Unknown link type.');
    const writeDocs = args.writeDocs !== false;
    const repoint = args.repoint === true;
    const library = this.paths.mergedSkills;
    const lines = [], conflicts = [];
    const libState = inspectDestination(library);
    const libraryReady = libState.kind === 'directory';
    if (!libraryReady) conflicts.push('The library has not been built yet. Rebuild the library first.');
    // One call for all chosen agents: the core writes a shared instruction file once and plans a shared
    // folder once (as a copy when any agent sharing it cannot follow links).
    const chosen = libraryReady ? planProject({
      projectRoot: p.path, targetSelector: targets, vars: buildVars({ projectRoot: p.path, env: {} }), templatesDir: this.paths.templatesDir,
      vaultRoot: library, linkType: link, preserve: true, force: repoint, platform: process.platform, withDoc: writeDocs,
    }) : [];
    for (const plan of chosen) {
      const t = TARGETS[plan.target];
      for (const a of plan.actions) lines.push(describeAction(a, p.path, library, this.primary()));
      for (const n of plan.notes) lines.push({ tone: 'note', text: `${t.id}: ${humanNote(n)}` });
      for (const c of plan.conflicts) conflicts.push(`${t.id}: ${humanConflict(c, repoint)}`);
    }
    if (libraryReady && !lines.some(l => l.tone !== 'note')) lines.push({ tone: 'note', text: 'Already wired. Nothing to change.' });
    return { title: `Wire ${p.name}`, lines, conflicts, ok: conflicts.length === 0, args: { projectId: p.id, targets, link, writeDocs, repoint },
      // apply() was called with a plan built moments ago by describe(); applyPlan re-checks every precondition.
      run: () => {
        for (const plan of chosen) applyPlan(plan);
        const changed = chosen.filter(plan => plan.actions.some(a => a.kind !== 'append-gitignore')).map(plan => plan.target);
        const hints = [...new Set(changed.map(t => RELOAD[t]).filter(Boolean))].map(text => ({ tone: 'note', text }));
        return { lines: [...lines, ...(hints.length ? [{ tone: 'note', text: 'To use them in a session that is already open:' }, ...hints] : [])] };
      } };
  }
}

const TOOL_NAMES = { claude: 'Claude Code', codex: 'Codex', gemini: 'Gemini CLI', cursor: 'Cursor', antigravity: 'Antigravity' };

/** What makes an already-open session notice new skills. Claude Code's is documented and was exercised; the rest are from each tool's documentation. */
const RELOAD = {
  claude: 'Claude Code: run /reload-skills',
  codex: 'Codex: picked up automatically; restart it if a skill is missing',
  gemini: 'Gemini CLI: run /skills reload',
  cursor: 'Cursor: start a new chat if a skill is missing',
  generic: 'Tools reading .agents/skills: Codex picks it up; Gemini CLI needs /skills reload',
  antigravity: 'Antigravity: start a new session',
};

function rel(projectRoot, p) { const r = path.relative(projectRoot, p); return r && !r.startsWith('..') ? r.split(path.sep).join('/') : p; }
function where(target, library, vault) {
  if (samePath(target, library)) return 'the library';
  if (vault && samePath(target, vault)) return 'your vault';
  return target;
}
function describeAction(a, root, library, vault) {
  const d = rel(root, a.destination);
  switch (a.kind) {
    case 'write-file': return { tone: 'add', text: `Write ${d}` };
    case 'mkdir': return { tone: 'add', text: `Create the folder ${d}` };
    case 'create-link': return { tone: 'add', text: `Link ${d} to ${where(a.source, library, vault)}` };
    case 'copy-directory': return { tone: 'add', text: `Copy ${where(a.source, library, vault)} into ${d}` };
    case 'refresh-copy': return { tone: 'change', text: `Refresh the copy in ${d} from ${where(a.source, library, vault)}. Skills you added there are kept.` };
    case 'copy-entries': return { tone: 'add', text: `Copy ${plural(a.entries.length, 'missing skill')} into ${d}, keeping the ${a.kept} already there` };
    case 'remove-link': return { tone: 'remove', text: `Unlink ${d} from ${a.expectedTarget}. That folder is not touched.` };
    case 'remove-directory': return { tone: 'remove', text: `Delete the folder ${d}` };
    case 'append-gitignore': return { tone: 'add', text: `Add ${a.lines.join(', ')} to ${d}` };
    default: return { tone: 'note', text: `${a.kind} ${d}` };
  }
}
function humanNote(n) {
  return n.replace(/ — skipping \(use --force to overwrite\)/, ' is kept as it is')
    .replace(/already links to .*/, 'already linked to the library')
    .replace(/: preserved (\d+) existing entries; nothing to merge/, ' keeps its $1 skills; nothing missing')
    .replace(/planned for an earlier target/, 'is written once for both agents')
    .replace(/is shared with (\w+) and planned there/, 'is the same folder as $1; set up once')
    .replace(/: copy is up to date/, ' is a copy and is up to date');
}
function humanConflict(c, repoint) {
  const r = c.reason || String(c);
  if (/another source|broken link/.test(r)) return repoint ? r : `${rel('', c.path)} points somewhere else. Use Repoint to link it to the library instead.`;
  if (/a file is in the way/.test(r)) return `${c.path} is a file. Move it aside first.`;
  return r;
}
function titleFor(change) { return change && typeof change.kind === 'string' ? change.kind : 'Change'; }
function message(e) {
  if (e instanceof ReadError || e instanceof AgentforgeError) return e.message;
  return 'The change could not be made. Check the dashboard console.';
}

module.exports = { WriteService, KINDS };
