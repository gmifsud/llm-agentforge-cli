'use strict';
/**
 * Skill sets, stored and built.
 *
 *   ~/.agentforge/sets.json        the rules of every set (the only thing stored)
 *   ~/.agentforge/views/<set>/     a real folder of per-skill links, made the way the library is, with only the set's skills
 *
 * A set is resolved from the library's winners, so same-name choices and source order already apply. It is a view: it is
 * never a source, it never holds a copy, and nothing outside the views folder is written.
 */
const fs = require('node:fs');
const path = require('node:path');
const { atomicWrite } = require('../infra/paths');
const { failure, refused, usage } = require('../domain/errors');
const { validateSetName, normaliseSet, resolveSet } = require('../domain/sets');
const { materializeView, removeLinksDir } = require('../deployment/build-view');
const { parseFrontmatter } = require('../discovery/skill-lint');
const { estimateListing } = require('../discovery/listing-budget');
const { samePath } = require('../infra/fs-inspect');
const { loadSavedProjects } = require('../infra/projects');
const { inspectProject } = require('./project');

const VERSION = 1;
const setsFile = (paths) => path.join(paths.agentforgeDir, 'sets.json');
const setView = (paths, name) => path.join(paths.viewsDir, name);

/** The stored sets. None yet is empty; a damaged file is refused, never overwritten. */
function loadSets(paths) {
  const file = setsFile(paths);
  if (!fs.existsSync(file)) return { version: VERSION, sets: {} };
  let parsed;
  try { parsed = JSON.parse(fs.readFileSync(file, 'utf8')); } catch {
    throw failure('CONFIG_CORRUPT', `${file} is not valid JSON. Fix or move it; Agentforge will not overwrite it.`);
  }
  if (!parsed || parsed.version !== VERSION || !parsed.sets || typeof parsed.sets !== 'object' || Array.isArray(parsed.sets)) {
    throw failure('CONFIG_INVALID', `${file} must look like {"version": 1, "sets": {"<name>": {"rules": [...]}}}.`);
  }
  const sets = {};
  try { for (const name of Object.keys(parsed.sets)) { validateSetName(name); sets[name] = normaliseSet(parsed.sets[name]); } } catch (e) {
    throw failure('CONFIG_INVALID', `${file}: ${e.message}`);
  }
  return { version: VERSION, sets };
}

/** Saved in name order, so the file is the same on every run. */
function saveSets(paths, doc) {
  const sets = {};
  for (const name of Object.keys(doc.sets).sort()) sets[name] = normaliseSet(doc.sets[name]);
  fs.mkdirSync(paths.agentforgeDir, { recursive: true });
  atomicWrite(setsFile(paths), JSON.stringify({ version: VERSION, sets }, null, 2) + '\n');
}

/** The library's winners with what a rule may ask about them: the skill's own category, and its description for the budget. */
function describeEntries(entries) {
  return entries.map((e) => {
    let fields = {};
    try { fields = parseFrontmatter(fs.readFileSync(path.join(e.absolutePath, 'SKILL.md'), 'utf8')).fields || {}; } catch { /* no readable front matter: no category */ }
    return { ...e, category: typeof fields.category === 'string' ? fields.category.trim() : '', description: typeof fields.description === 'string' ? fields.description : '' };
  });
}

/**
 * Build every set (or one) from the library's winners. A folder in views/ that holds anything but links is refused,
 * as the library's is. A dry run resolves and counts but writes nothing.
 */
function buildSets({ paths, entries, only, dryRun = false }) {
  const doc = loadSets(paths);
  const library = describeEntries(entries);
  const rows = [];
  for (const name of Object.keys(doc.sets).sort()) {
    if (only && name !== only) continue;
    const resolved = resolveSet(doc.sets[name], library);
    const row = { name, count: resolved.entries.length, unmatched: resolved.unmatched, linked: 0 };
    if (!dryRun) row.linked = materializeView(setView(paths, name), resolved.entries).linked;
    rows.push(row);
  }
  return rows;
}

/** Make a set, or with `force` replace the rules of one, and build it. A set that selects nothing, or a rule that does, is refused. */
function createSet({ paths, name, rules, entries, force = false }) {
  validateSetName(name);
  if (!rules.some((r) => !r.exclude)) throw usage('a set needs at least one include rule, for example --include category:offshore-engineering');
  const doc = loadSets(paths);
  if (doc.sets[name] && !force) throw refused('SET_EXISTS', `set "${name}" already exists; use --force to replace its rules`);
  const resolved = resolveSet({ rules }, describeEntries(entries));
  if (resolved.unmatched.length) throw refused('SET_RULE_EMPTY', `these rules match no skill in the library: ${resolved.unmatched.map((r) => `${r.type}:${r.value}`).join(', ')}`);
  doc.sets[name] = { rules };
  saveSets(paths, doc);
  const [row] = buildSets({ paths, entries, only: name });
  return { ...row, resolved };
}

/** The agent's budget for a set: how many of its descriptions fit, from the set's own skills. */
function setBudget(skills, { budgetChars, contextTokens } = {}) {
  return estimateListing(skills, { budgetChars, contextTokens });
}

/** What a link points at: the library, a set, or something else. `target` is where the link resolves. */
function readsOf(paths, target) {
  if (!target) return { kind: 'other' };
  if (samePath(target, paths.mergedSkills)) return { kind: 'library' };
  if (samePath(path.dirname(target), paths.viewsDir)) return { kind: 'set', name: path.basename(target) };
  return { kind: 'other' };
}

/**
 * Agents in these projects whose skills folder links to this set. Without a list it is the remembered projects; the
 * dashboard passes the ones it is showing, which include any given for just that session.
 */
function agentsReading({ paths, name, projects }) {
  const readers = [];
  let roots = projects;
  if (!roots) { try { roots = loadSavedProjects(paths); } catch { roots = []; /* a damaged project list is reported where it is used */ } }
  for (const projectRoot of roots) {
    let report;
    try { report = inspectProject({ projectRoot, vaultRoot: paths.mergedSkills }); } catch { continue; }
    for (const t of report.targets) {
      if (t.link.kind !== 'link' || !t.link.resolvedTarget) continue;
      const reads = readsOf(paths, t.link.resolvedTarget);
      if (reads.kind === 'set' && reads.name.toLowerCase() === name.toLowerCase()) readers.push({ project: projectRoot, target: t.id });
    }
  }
  return readers;
}

/** Remove a set and its folder of links. Refused while an agent reads it, unless forced (their links then break). */
function removeSet({ paths, name, force = false, projects }) {
  const doc = loadSets(paths);
  if (!doc.sets[name]) throw refused('NO_SUCH_SET', `no set called "${name}"`);
  const readers = agentsReading({ paths, name, projects });
  if (readers.length && !force) {
    const list = readers.map((r) => `${path.basename(r.project)} (${r.target})`).join(', ');
    throw refused('SET_IN_USE', `set "${name}" is read by ${readers.length} agent${readers.length === 1 ? '' : 's'}: ${list}. Point them elsewhere first, or use --force and their links will break`);
  }
  delete doc.sets[name];
  saveSets(paths, doc);
  const dir = setView(paths, name);
  let removedView = false;
  if (fs.existsSync(dir)) { try { removeLinksDir(dir); removedView = true; } catch { /* holds something that is not a link: left alone */ } }
  return { removedView, readers };
}

/** The folder an agent should be linked to for a set, which must exist and be built. */
function viewForLink(paths, name) {
  const doc = loadSets(paths);
  if (!doc.sets[name]) throw refused('NO_SUCH_SET', `no set called "${name}". Create it with "agentforge set create ${name} --include ..."`);
  const dir = setView(paths, name);
  if (!fs.existsSync(dir)) throw refused('SET_NOT_BUILT', `set "${name}" has not been built yet. Run "agentforge set build"`);
  return dir;
}

module.exports = { setsFile, setView, loadSets, saveSets, describeEntries, buildSets, createSet, setBudget, readsOf, agentsReading, removeSet, viewForLink };
