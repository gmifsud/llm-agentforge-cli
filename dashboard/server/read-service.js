'use strict';

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { createHash, randomUUID } = require('node:crypto');
const { createPaths, loadConfig, loadRegistry, resolvePrimarySource, resolveDeployRoot } = require('../../src/infra/paths');
const { sourceRootFor } = require('../../src/application/sources');
const { discoverSkills } = require('../../src/discovery/discover-skills');
const { computeView } = require('../../src/deployment/build-view');
const { inspectProject } = require('../../src/application/project');
const { TARGETS } = require('../../src/domain/targets');
const { samePath, isWithinLexical } = require('../../src/infra/fs-inspect');
const { ERROR, LIMITS, ReadError } = require('./constants');
const { loadSavedProjects, projectsFile, diffLibrary, loadVerifications, verificationFor, verificationsFile, skillsBasis } = require('./workspace');
const { lintSkill, parseFrontmatter, findShadows, personalLevels } = require('../../src/discovery/skill-lint');
const { estimateListing } = require('../../src/discovery/listing-budget');
const { digestSkill } = require('../../src/discovery/skill-digest');
const { lockFile, readLock, snapshot, diffLock } = require('../../src/application/lock');
const setsApp = require('../../src/application/sets');
const { diffLines } = require('../../src/discovery/text-diff');
const { copyState } = require('../../src/deployment/copy-state');

const COMPARE_LIMITS = Object.freeze({ maxFiles: 500, maxBytes: 5 * 1024 * 1024 });
const RUNS_CODE = /\.(sh|bash|ps1|psm1|bat|cmd|py|js|mjs|cjs|ts|rb|pl|exe)$/i;

const idFor = (...values) => createHash('sha256').update(JSON.stringify(values)).digest('hex');
const nameKey = (name) => process.platform === 'win32' ? name.toLowerCase() : name;
const compare = (a, b) => a < b ? -1 : a > b ? 1 : 0;

/** Check link targets BEFORE realpath/stat can follow a link into a UNC/WSL share. */
function localPath(input, depth = 0, memo = new Map()) {
  if (typeof input !== 'string' || !input || input.includes('\0') || depth > 24) {
    throw new ReadError(ERROR.BOUNDARY, 'Invalid or cyclic local path.', 403);
  }
  const clean = input.replace(/^\\\\\?\\(?=[a-z]:\\)/i, '');
  if (/^[\\/]{2}|^\\\?\\|^\/mnt\//i.test(clean)) {
    throw new ReadError(ERROR.BOUNDARY, 'Network and WSL paths are outside this local session.', 403);
  }
  const absolute = path.resolve(clean);
  const root = path.parse(absolute).root;
  let current = root;
  const pieces = absolute.slice(root.length).split(path.sep).filter(Boolean);
  for (let i = 0; i < pieces.length; i++) {
    current = path.join(current, pieces[i]);
    if (memo.has(current)) {
      const resolved = memo.get(current);
      if (resolved !== current) return localPath(path.join(resolved, ...pieces.slice(i + 1)), depth + 1, memo);
      continue;
    }
    let stat;
    try { stat = fs.lstatSync(current); } catch (e) {
      if (['ENOENT', 'ENOTDIR'].includes(e.code)) return absolute;
      throw new ReadError(ERROR.UNAVAILABLE, 'A local path could not be inspected.');
    }
    if (stat.isSymbolicLink()) {
      const target = fs.readlinkSync(current);
      // Validate the raw target before joining (Windows device prefixes included).
      const normalized = target.replace(/^\\\\\?\\(?=[a-z]:\\)/i, '');
      if (/^[\\/]{2}/.test(normalized)) throw new ReadError(ERROR.BOUNDARY, 'A link targets a network or WSL location.', 403);
      const resolved = localPath(path.resolve(path.dirname(current), normalized), depth + 1, memo);
      memo.set(current, resolved);
      return localPath(path.join(resolved, ...pieces.slice(i + 1)), depth + 1, memo);
    }
    memo.set(current, current);
  }
  return absolute;
}

function contained(root, candidate) {
  if (!isWithinLexical(root, candidate) || !isWithinLexical(localPath(root), localPath(candidate))) {
    throw new ReadError(ERROR.BOUNDARY, 'The requested file escapes its source.', 403);
  }
}

function availability(root) {
  localPath(root);
  try {
    if (!fs.statSync(root).isDirectory()) return 'unreadable';
    fs.readdirSync(root);
    return 'available';
  } catch (e) { return ['ENOENT', 'ENOTDIR'].includes(e.code) ? 'missing' : 'unreadable'; }
}

function safeLocation(location, kind) {
  if (kind !== 'git') return location;
  try { const url = new URL(location); url.username = ''; url.password = ''; url.search = ''; url.hash = ''; return url.toString(); }
  catch { return /^git@[a-z0-9.-]+:.+$/i.test(location) ? location.split(/[?#]/)[0] : '[Git location withheld]'; }
}

/** Bounded ordinary-file reads shared by instruction and revision inspection. */
function readPlainFile(root, file, limit = LIMITS.documentBytes) {
  contained(root, file);
  const before = fs.lstatSync(file);
  if (!before.isFile() || before.isSymbolicLink()) throw new ReadError(ERROR.BOUNDARY, 'Only ordinary files can be displayed.', 403);
  if (before.size > limit) throw new ReadError(ERROR.LARGE, 'File exceeds the local read size limit.', 413);
  let fd;
  try {
    fd = fs.openSync(file, 'r');
    const opened = fs.fstatSync(fd);
    if (opened.ino !== before.ino || opened.dev !== before.dev) throw new ReadError(ERROR.CHANGED, 'The file changed while opening.', 409);
    const buffer = Buffer.alloc(limit + 1);
    let bytes = 0, read;
    do { read = fs.readSync(fd, buffer, bytes, buffer.length - bytes, bytes); bytes += read; } while (read && bytes < buffer.length);
    if (bytes > limit) throw new ReadError(ERROR.LARGE, 'File exceeds the local read size limit.', 413);
    contained(root, file);
    const after = fs.lstatSync(file), final = fs.fstatSync(fd);
    if (after.isSymbolicLink() || after.ino !== opened.ino || after.dev !== opened.dev || final.size !== opened.size || final.mtimeMs !== opened.mtimeMs || bytes !== final.size) {
      throw new ReadError(ERROR.CHANGED, 'The file changed during reading. Try again.', 409);
    }
    return new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(0, bytes));
  } finally { if (fd !== undefined) fs.closeSync(fd); }
}

/** Managed clones use .git directories. Unsupported layouts are explicitly unknown.
 * No executable, config, hooks, gitdir/commondir pointer or object store is consulted.
 */
function revision(root) {
  try {
    const gitRoot = path.join(root, '.git');
    contained(root, gitRoot);
    if (!fs.lstatSync(gitRoot).isDirectory()) return null;
    const hash = /^[a-f0-9]{40}(?:[a-f0-9]{24})?$/i;
    const head = readPlainFile(root, path.join(gitRoot, 'HEAD'), LIMITS.revisionHeadBytes).trim();
    if (hash.test(head)) return head;
    const ref = /^ref: (refs\/[a-z0-9_./-]+)$/i.exec(head)?.[1];
    if (!ref || ref.split('/').some(p => !p || p === '.' || p === '..')) return null;
    try {
      const value = readPlainFile(root, path.join(gitRoot, ...ref.split('/')), LIMITS.revisionHeadBytes).trim();
      return hash.test(value) ? value : null;
    } catch (e) { if (e.code !== 'ENOENT') throw e; }
    const packed = readPlainFile(root, path.join(gitRoot, 'packed-refs'), LIMITS.revisionRefsBytes);
    for (const line of packed.split(/\r?\n/)) {
      const [value, name] = line.split(' ');
      if (name === ref && hash.test(value)) return value;
    }
    return null;
  } catch { return null; }
}

class ReadService {
  constructor({ homedir = os.homedir(), projects = [process.cwd()], vault, env = process.env } = {}) {
    this.paths = createPaths({ homedir, scriptDir: path.resolve(__dirname, '../..') });
    this.env = { AGENTFORGE_VAULT_ROOT: env.AGENTFORGE_VAULT_ROOT };
    this.vault = vault;
    this.sessionProjects = [...new Set(projects.map(p => { localPath(p); return path.resolve(p); }))];
    this.projects = [];
    this.config = {};
    this.catalog = null;
    this.documents = new Map();
    this.stale = true;
    // Fill the list now; a corrupt projects.json is reported by context() on the first read instead.
    try { this.loadProjects(); } catch {
      this.projects = this.sessionProjects.map(p => ({ id: idFor('project', p), name: path.basename(p) || p, path: p, origin: 'session', local: true }));
    }
  }

  /** Session projects (from --project) plus the saved list; re-read on every context so writes show up. */
  loadProjects() {
    contained(this.paths.homedir, projectsFile(this.paths));
    const saved = loadSavedProjects(this.paths);
    const seen = new Set(), list = [];
    const add = (p, origin) => {
      const k = process.platform === 'win32' ? p.toLowerCase() : p;
      if (seen.has(k)) return; seen.add(k);
      let local = true; try { localPath(p); } catch { local = false; }
      list.push({ id: idFor('project', p), name: path.basename(p) || p, path: p, origin, local });
    };
    for (const p of this.sessionProjects) add(p, 'session');
    for (const p of saved) add(path.resolve(p), 'saved');
    this.projects = list;
    return list;
  }

  context() {
    try {
      contained(this.paths.homedir, this.paths.configJson);
      const config = loadConfig(this.paths);
      this.config = config;
      this.loadProjects();
      // The core fallback probes this path with existsSync, which follows links.
      if (!this.vault && !this.env.AGENTFORGE_VAULT_ROOT && !config.vaultRoot) {
        localPath(this.paths.mergedSkills);
        contained(this.paths.homedir, this.paths.reposJson);
      }
      const args = { cliVault: this.vault, env: this.env, paths: this.paths, config };
      const primaryRoot = resolvePrimarySource(args);
      const deployment = resolveDeployRoot(args);
      localPath(primaryRoot); localPath(deployment.root);
      return { readOnly: false, platform: process.platform, projects: this.projects, primaryRoot, deployment, library: this.paths.mergedSkills };
    } catch (e) { throw this.configError(e); }
  }

  configError(e) {
    if (e instanceof ReadError) return e;
    return new ReadError(e.code || ERROR.UNAVAILABLE, 'Agent Forge configuration could not be read. Check config.json and repos.json.');
  }

  /** @returns {import('../contracts').Catalog} */
  refresh() {
    this.stale = true;
    const startedAt = new Date().toISOString();
    const context = this.context();
    let repos;
    try { contained(this.paths.homedir, this.paths.reposJson); repos = loadRegistry(this.paths).repositories; }
    catch (e) { throw this.configError(e); }
    const sourceNames = new Set();
    for (const repo of repos) {
      const key = repo.name.toLowerCase();
      if (sourceNames.has(key)) throw new ReadError('CONFIG_INVALID', 'Duplicate source identifiers in repos.json.');
      sourceNames.add(key);
    }
    const definitions = [{ name: 'Primary vault', kind: 'primary', root: context.primaryRoot, location: context.primaryRoot }];
    for (const repo of repos) {
      let root;
      try { root = sourceRootFor(this.paths, repo); }
      catch { throw new ReadError('CONFIG_INVALID', 'A source identifier is invalid.'); }
      definitions.push({ name: repo.name, kind: repo.type, root, location: safeLocation(repo.url_or_path, repo.type), repo });
    }
    const sources = [], skills = [], rejected = [], observations = new Map(), documents = new Map();
    const warnings = [...context.deployment.warnings];
    for (const def of definitions) {
      const source = { id: idFor(def.kind, def.name, def.root), key: def.kind === 'primary' ? 'vault' : def.name, name: def.name, kind: def.kind,
        root: def.root, location: def.location, state: 'available', revision: null, count: null, rejectionCount: 0, error: null };
      sources.push(source);
      try {
        source.state = availability(def.root);
        if (source.state === 'missing' && def.kind === 'git') source.state = 'not-fetched';
        if (source.state !== 'available') { source.error = 'Source folder is not available for inspection.'; continue; }
        // Memoize ancestry only for this observation. Document reads validate afresh.
        const pathMemo = new Map();
        const physicalRoot = localPath(def.root, 0, pathMemo);
        const found = discoverSkills(def.root, {
          ...(def.kind === 'primary' ? { maxDepth: 1, manifest: false } : {}),
          checkRead: (p) => {
            if (!isWithinLexical(def.root, p) || !isWithinLexical(physicalRoot, localPath(p, 0, pathMemo))) {
              throw new ReadError(ERROR.BOUNDARY, 'The requested file escapes its source.', 403);
            }
          }, reportReadErrors: true,
        });
        observations.set(source.id, found);
        source.count = found.skills.length;
        source.rejectionCount = found.rejected.length;
        if (def.kind === 'git') { source.revision = revision(def.root); if (!source.revision) warnings.push(`Local revision unavailable for ${source.name}.`); }
        for (const entry of found.skills) {
          const skill = { id: idFor(source.id, entry.relativePath), name: entry.name, sourceId: source.id, relativePath: entry.relativePath };
          skills.push(skill);
          documents.set(skill.id, { ...skill, root: def.root, directory: entry.absolutePath, physicalRoot });
        }
        rejected.push(...found.rejected.map(r => ({ sourceId: source.id, path: r.path, reason: r.reason })));
      } catch (e) {
        source.state = e.code === ERROR.BOUNDARY ? 'rejected' : 'unreadable';
        source.error = e instanceof ReadError ? e.message : 'Source discovery failed.';
      }
      if (skills.length > LIMITS.candidates) throw new ReadError(ERROR.LIMIT, `Catalogue exceeds ${LIMITS.candidates} candidates.`);
    }
    let winnerIds = [], collisions = [], library = null, health = null, sourceOrder = [], sinceLastBuild = null;
    const preferences = this.config.preferences && typeof this.config.preferences === 'object' ? this.config.preferences : {};
    // A missing source cannot be treated as an intentionally empty contribution.
    const mergeAvailable = sources.every(s => s.state === 'available');
    if (mergeAvailable) {
      const view = computeView({ primaryRoot: context.primaryRoot, repos, preferences, sourcePriority: this.config.sourcePriority,
        cacheRootFor: repo => sourceRootFor(this.paths, repo), forceExternal: false,
        discover: (root, opts) => observations.get((opts?.manifest === false ? sources[0] : sources.find(s => s.kind !== 'primary' && s.root === root)).id),
      });
      winnerIds = view.entries.map(e => {
        const winner = skills.find(s => s.name === e.name && documents.get(s.id).directory === e.absolutePath &&
          (s.sourceId === sources[0].id ? e.source === 'vault' : sources.find(x => x.id === s.sourceId).name === e.source));
        if (!winner) throw new ReadError(ERROR.CHANGED, 'Sources changed during the merge observation. Refresh again.', 409);
        return winner.id;
      });
      // The primary vault is identified by its flag, never by the name "vault", which an old registry entry may also carry.
      const sourceIdFor = c => (c.primary ? sources[0].id : sources.find(s => s.kind !== 'primary' && s.name === c.source)?.id);
      const skillFor = c => skills.find(s => documents.get(s.id).directory === c.absolutePath && s.sourceId === sourceIdFor(c));
      const byName = k => (k === 'vault' ? sources[0] : sources.find(s => s.kind !== 'primary' && s.name === k));
      // Every same-name group, with why its winner won. kind is what a person needs to do about it:
      //   identical  every copy is the same content: nothing to decide
      //   choice     you picked one, and nothing has changed since
      //   order      your source order settled it
      //   default    only the built-in order settled it: worth a look
      //   changed    you picked one, and a copy has changed (or a new one appeared) since
      for (const clash of view.clashes) {
        const found = clash.candidates.map(c => ({ c, skill: skillFor(c) })).filter(x => x.skill);
        const winner = found.find(x => x.c.winner);
        if (!winner || found.length < 2) continue;
        for (const x of found) x.skill.digest = x.c.digest;
        const others = found.filter(x => x !== winner);
        const prefKey = Object.keys(preferences).find(k => nameKey(k) === nameKey(clash.name));
        const prefValue = prefKey ? preferences[prefKey] : null;
        const preferredSource = prefValue ? byName(typeof prefValue === 'string' ? prefValue : prefValue.source) : null;
        collisions.push({
          name: clash.name, winnerId: winner.skill.id, candidateIds: found.map(x => x.skill.id),
          preferredSourceId: preferredSource ? preferredSource.id : null,
          kind: others.every(x => x.c.identical) ? 'identical' : clash.stale ? 'changed' : clash.by,
          by: clash.by, stale: clash.stale,
          changedSourceIds: clash.changed.map(k => byName(k)?.id).filter(Boolean),
          identicalIds: others.filter(x => x.c.identical).map(x => x.skill.id),
        });
      }
      sourceOrder = [...new Set(view.order.flatMap(k => (k === 'vault' ? sources.filter(s => s.key === 'vault') : [byName(k)]).filter(Boolean).map(s => s.id)))];
      // Can the skills the library will hold actually be invoked? Rules, listing budget, personal skills that hide them.
      const linted = winnerIds.map(id => ({ id, ...lintSkill(documents.get(id).directory) }));
      // What the set editor needs about each skill in the library: its own category, and how long its description is.
      const byId = new Map(skills.map(s => [s.id, s]));
      for (const l of linted) { const sk = byId.get(l.id); if (sk) { sk.category = l.category || ''; sk.descriptionChars = (l.description || '').length; } }
      const findings = linted.flatMap(l => l.findings.map(f => ({ skillId: l.id, skill: l.name, ...f })));
      const counts = { error: 0, warn: 0, info: 0 };
      for (const f of findings) counts[f.severity]++;
      health = {
        findings, counts,
        budget: estimateListing(linted, { budgetChars: this.config.listingBudgetChars, contextTokens: this.config.contextTokens }),
        shadows: findShadows(linted.map(l => l.name), personalLevels(this.paths.homedir)).map(s => ({ ...s, skillId: linted.find(l => l.name === s.name)?.id || null })),
      };
      contained(this.paths.homedir, this.paths.mergedSkills);
      library = { path: this.paths.mergedSkills, ...diffLibrary(this.paths.mergedSkills, view.entries) };
      // What changed in the sources since the last build. The record is only compared with; what the library should hold comes from disk.
      contained(this.paths.homedir, lockFile(this.paths));
      const record = readLock(this.paths);
      if (record) {
        const now = snapshot(view.entries, name => (name === 'vault' ? null : sources.find(s => s.kind !== 'primary' && s.name === name)?.revision ?? null));
        sinceLastBuild = { builtAt: record.builtAt, ...diffLock(record, now) };
      }
    } else warnings.push('Merge preview unavailable: one or more source folders could not be inspected.');
    if (!library) {
      contained(this.paths.homedir, this.paths.mergedSkills);
      const d = diffLibrary(this.paths.mergedSkills, []);
      library = { path: this.paths.mergedSkills, built: d.built, builtAt: d.builtAt, invalid: d.invalid, size: d.size, add: [], remove: [], change: [], inSync: null };
    }
    skills.sort((a, b) => compare(a.name, b.name) || compare(a.sourceId, b.sourceId) || compare(a.relativePath, b.relativePath));
    // The stored sets. A damaged file is reported and treated as none, so it cannot break the whole catalogue.
    let storedSets = [];
    try {
      contained(this.paths.homedir, setsApp.setsFile(this.paths));
      const doc = setsApp.loadSets(this.paths);
      storedSets = Object.keys(doc.sets).sort().map(name => ({ name, rules: doc.sets[name].rules, built: fs.existsSync(setsApp.setView(this.paths, name)) }));
    } catch (e) { warnings.push(e && e.message ? e.message : 'The skill sets could not be read.'); }
    // The library is the same for every project, so it is scanned once per read. The map lives only for this read.
    const libraryScan = new Map();
    const projects = this.projects.map(p => {
      try { return this.project(p.id, context, libraryScan); }
      catch (e) { return { project: p, readAt: new Date().toISOString(), deployment: context.deployment, targets: [], state: 'unreadable', warnings: [e instanceof ReadError ? e.message : 'Project could not be inspected.'] }; }
    });
    const catalog = { generation: randomUUID(), startedAt, completedAt: new Date().toISOString(),
      status: sources.some(s => s.state !== 'available') || rejected.length ? 'partial' : 'complete',
      sources, skills, winnerIds, collisions, rejected, warnings, mergeAvailable, library, projects, health, sourceOrder, sinceLastBuild, sets: storedSets,
      sourceOrderExplicit: Array.isArray(this.config.sourcePriority) && this.config.sourcePriority.length > 0 };
    this.documents = documents; this.catalog = catalog; this.stale = false;
    return catalog;
  }

  /**
   * Two candidates of one skill, side by side: what differs in the frontmatter, in the
   * instructions, and in the files they ship. Same staleness and boundary rules as document().
   */
  compare(idA, idB, generation) {
    if (this.stale || !this.catalog || generation !== this.catalog.generation) throw new ReadError(ERROR.STALE, 'Refresh the catalogue before comparing.', 409);
    if (idA === idB) throw new ReadError(ERROR.INVALID, 'Choose two different skills to compare.', 400);
    const side = id => {
      const entry = this.documents.get(id);
      if (!entry) throw new ReadError(ERROR.NOT_FOUND, 'Skill not found.', 404);
      const file = path.join(entry.directory, 'SKILL.md');
      contained(entry.root, file);
      if (localPath(entry.root) !== entry.physicalRoot) throw new ReadError(ERROR.CHANGED, 'The source root changed. Refresh the catalogue.', 409);
      let text;
      try { text = readPlainFile(entry.root, file); } catch (e) {
        if (e instanceof ReadError) throw e;
        throw new ReadError(ERROR.UNAVAILABLE, 'SKILL.md could not be read as UTF-8 text. Refresh and try again.');
      }
      const fm = parseFrontmatter(text);
      let files = null, digest = null, changedAt = null;
      try {
        const d = digestSkill(entry.directory, COMPARE_LIMITS);
        digest = d.digest;
        let newest = 0;
        files = d.files.map(f => {
          if (!f.link) { try { newest = Math.max(newest, fs.statSync(path.join(entry.directory, f.path)).mtimeMs); } catch { /* raced away */ } }
          return { path: f.path, size: f.size, link: Boolean(f.link), runs: RUNS_CODE.test(f.path) };
        });
        changedAt = newest ? new Date(newest).toISOString() : null;
      } catch { /* too large to inventory: reported as unknown */ }
      return { id, sourceId: entry.sourceId, name: entry.name, relativePath: entry.relativePath, fields: fm.fields || {}, body: fm.fields ? fm.body : text, digest, files, changedAt };
    };
    const a = side(idA), b = side(idB);
    const order = ['name', 'description', 'when_to_use'];
    const keys = [...new Set([...Object.keys(a.fields), ...Object.keys(b.fields)])].sort((x, y) => (order.indexOf(x) + 1 || 99) - (order.indexOf(y) + 1 || 99) || compare(x, y));
    const fields = keys.map(key => ({ key, a: a.fields[key] ?? null, b: b.fields[key] ?? null, same: (a.fields[key] ?? null) === (b.fields[key] ?? null) }));
    const names = new Set([...(a.files || []).map(f => f.path), ...(b.files || []).map(f => f.path)]);
    const fileDiff = a.files && b.files ? [...names].sort().filter(p => p !== 'SKILL.md').map(p => {
      const fa = a.files.find(f => f.path === p), fb = b.files.find(f => f.path === p);
      return { path: p, inA: Boolean(fa), inB: Boolean(fb), runs: Boolean((fa || fb).runs), same: Boolean(fa && fb && fa.size === fb.size) };
    }) : null;
    const strip = s => ({ id: s.id, sourceId: s.sourceId, name: s.name, relativePath: s.relativePath, digest: s.digest, changedAt: s.changedAt,
      fileCount: s.files ? s.files.length : null, scriptCount: s.files ? s.files.filter(f => f.runs).length : null });
    return { generation, readAt: new Date().toISOString(), a: strip(a), b: strip(b), identical: Boolean(a.digest && a.digest === b.digest),
      fields, files: fileDiff, body: diffLines(a.body, b.body) };
  }

  document(id, generation) {
    if (this.stale || !this.catalog || generation !== this.catalog.generation) throw new ReadError(ERROR.STALE, 'Refresh the catalogue before reading this document.', 409);
    const entry = this.documents.get(id);
    if (!entry) throw new ReadError(ERROR.NOT_FOUND, 'Skill not found.', 404);
    const file = path.join(entry.directory, 'SKILL.md');
    contained(entry.root, file);
    if (localPath(entry.root) !== entry.physicalRoot) throw new ReadError(ERROR.CHANGED, 'The source root changed. Refresh the catalogue.', 409);
    try {
      const text = readPlainFile(entry.root, file);
      return { id, sourceId: entry.sourceId, relativePath: entry.relativePath, text, readAt: new Date().toISOString() };
    } catch (e) {
      if (e instanceof ReadError) throw e;
      throw new ReadError(ERROR.UNAVAILABLE, 'SKILL.md could not be read as UTF-8 text. Refresh and try again.');
    }
  }

  project(id, context, libraryScan) {
    const { deployment, primaryRoot } = context || this.context();
    const project = this.projects.find(p => p.id === id);
    if (!project) throw new ReadError(ERROR.NOT_FOUND, 'Project not configured for this session.', 404);
    if (!project.local) {
      return { project, readAt: new Date().toISOString(), deployment, targets: [], state: 'unreadable', warnings: ['Network and WSL folders are outside this local session.'] };
    }
    let state;
    try { state = availability(project.path); } catch { state = 'unreadable'; }
    const result = { project, readAt: new Date().toISOString(), deployment, targets: [], state, warnings: [] };
    if (state !== 'available') { result.warnings.push(state === 'missing' ? 'This folder no longer exists.' : 'This folder could not be read.'); return result; }
    const library = this.paths.mergedSkills;
    contained(this.paths.homedir, verificationsFile(this.paths));
    const verifications = loadVerifications(this.paths);
    // InspectProject follows target links; validate their local boundaries first.
    for (const target of Object.values(TARGETS)) {
      localPath(path.join(project.path, target.doc));
      localPath(path.join(project.path, target.dir, 'skills'));
    }
    localPath(deployment.root);
    const libraryState = availability(deployment.root);
    if (libraryState !== 'available') result.warnings.push('Effective skill library is missing or unreadable.');
    const report = inspectProject({ projectRoot: project.path, vaultRoot: deployment.root, checkRead: localPath, scan: libraryScan });
    result.targets = report.targets.map(t => {
      let docExists = false;
      try { docExists = fs.statSync(path.join(project.path, t.doc)).isFile(); } catch { /* absence is reported */ }
      const readable = t.link.kind === 'directory' || (t.link.kind === 'link' && !t.link.broken)
        ? availability(path.join(project.path, t.dir, 'skills')) === 'available' : true;
      // What a working link feeds the agent: the library (all sources), the vault alone, or something else.
      let feeds = 'none', setName = null;
      if (t.link.kind === 'link' && t.link.broken) feeds = 'broken';
      else if (t.link.kind === 'link' && readable) {
        const reads = setsApp.readsOf(this.paths, t.link.resolvedTarget);
        if (reads.kind === 'set') setName = reads.name;
        feeds = samePath(t.link.resolvedTarget, library) ? 'library' : samePath(t.link.resolvedTarget, primaryRoot) ? 'vault' : setName ? 'set' : 'elsewhere';
      } else if (t.link.kind === 'directory') feeds = 'copy';
      else if (t.link.kind === 'file') feeds = 'blocked';
      else if (!readable) feeds = 'unreadable';
      // A healthy link is no use to a tool that ignores links (measured: Antigravity).
      if (t.needsCopy && (feeds === 'library' || feeds === 'vault' || feeds === 'elsewhere' || feeds === 'set')) feeds = 'needs-copy';
      // A copy made by Agentforge knows what it was copied from, so it can be told fresh from stale against the library.
      let copy = null;
      if (t.link.kind === 'directory') { try { const c = copyState(path.join(project.path, t.dir), library); copy = c.managed ? { state: c.state, copiedAt: c.copiedAt || null } : null; } catch { copy = null; } }
      // What the tool itself last reported, and whether the folder has changed since.
      const stored = verificationFor(verifications, project.path, t.id);
      const verification = stored ? { level: stored.level, tool: stored.tool, detail: stored.detail, at: stored.at, stale: stored.basis !== skillsBasis(path.join(project.path, t.dir)) } : null;
      return { id: t.id, dir: t.dir, doc: t.doc, docExists, optIn: Boolean(t.optIn), copy, verification,
        kind: t.link.kind, health: readable ? t.linkHealth : 'unreadable', resolvedTarget: t.link.resolvedTarget || null, feeds, set: setName,
        entries: t.link.kind === 'directory' ? t.link.entries.length : null,
        match: t.link.kind === 'link' && !t.link.broken && readable && libraryState === 'available'
          ? (samePath(t.link.resolvedTarget, deployment.root) ? 'matches' : 'differs') : 'unknown' };
    });
    return result;
  }
}
module.exports = { ReadService, localPath, contained, availability };
