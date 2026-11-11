'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { discoverSkills } = require('../discovery/discover-skills');
const { digestSkill } = require('../discovery/skill-digest');
const { inspectDestination, removeLinkOnly, createDirectoryLink, IS_WIN } = require('../infra/fs-inspect');
const { refused } = require('../domain/errors');

/**
 * Compute the merged view: one link per exported skill name.
 * Pure: reads sources, returns { entries, collisions, identical, clashes, rejected, order }.
 *   order       source keys, highest priority first, as actually applied
 *
 *   entries     [{ name, source, absolutePath }]            what the library will hold
 *   collisions  [{ name, kept, dropped, by, preferred?, stale? }]  same name, different content
 *   identical   [{ name, kept, dropped }]                   same name, same content: nothing to decide
 *   clashes     [{ name, winner, by, stale, changed, candidates: [{ source, absolutePath, digest, identical }] }]
 *
 * A same-name clash is settled in this order:
 *   1. Identical copies (equal content digest) are not a clash at all.
 *   2. A per-skill choice in `preferences` wins. A choice may be a source name, or
 *      { source, digests } pinned to the content it was made against; if any
 *      candidate has changed since, the choice still holds but is flagged stale.
 *   3. Otherwise the source highest in the order wins: `sourcePriority` first,
 *      then the default order (vault, then registry order). `forceExternal`
 *      (the CLI's --force) puts the vault last.
 *
 * by: 'choice' | 'order' (an explicit sourcePriority or --force decided it) | 'default'.
 */
function computeView({ primaryRoot, repos, cacheRootFor, forceExternal = false, discover = discoverSkills, preferences = {}, sourcePriority = [], digest = (dir) => digestSkill(dir).digest }) {
  const rejected = [];
  const groups = new Map();
  // `primary` marks the vault itself. It is tracked separately from the name because an older
  // registry may hold a source that someone called "vault".
  const add = (source, s, primary = false) => {
    const k = key(s.name);
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push({ name: s.name, source, absolutePath: s.absolutePath, primary });
  };

  const primary = discover(primaryRoot, { maxDepth: 1, manifest: false });
  rejected.push(...primary.rejected.map((r) => ({ source: 'vault', ...r })));
  for (const s of primary.skills) add('vault', s, true);

  const defaultOrder = ['vault'];
  for (const repo of repos) {
    defaultOrder.push(repo.name);
    const root = repo.type === 'git' ? cacheRootFor(repo) : repo.url_or_path;
    if (!fs.existsSync(root)) { rejected.push({ source: repo.name, path: root, reason: 'source path not found (not fetched?)' }); continue; }
    const found = discover(root);
    rejected.push(...found.rejected.map((r) => ({ source: repo.name, ...r })));
    const seen = new Set();
    for (const s of found.skills) {
      // Two skills with one name inside a single source: the first found stands for that source.
      if (seen.has(key(s.name))) { rejected.push({ source: repo.name, path: s.absolutePath, reason: 'another skill in this source has the same name' }); continue; }
      seen.add(key(s.name));
      add(repo.name, s);
    }
  }

  const explicit = (Array.isArray(sourcePriority) ? sourcePriority : []).filter((s) => defaultOrder.includes(s));
  let order = [...new Set([...explicit, ...defaultOrder])];
  if (forceExternal) order = [...order.filter((s) => s !== 'vault'), 'vault'];
  const rank = new Map(order.map((s, i) => [s, i]));
  const prefer = new Map(Object.entries(preferences || {}).map(([n, v]) => [key(n), v]));

  const entries = [], collisions = [], identical = [], clashes = [];
  for (const [k, group] of groups) {
    if (group.length === 1) { entries.push({ name: group[0].name, source: group[0].source, absolutePath: group[0].absolutePath }); continue; }
    const candidates = group.map((c) => { let d = null; try { d = digest(c.absolutePath); } catch { /* unreadable: treated as different */ } return { ...c, digest: d }; });
    const pref = prefer.get(k);
    const chosenSource = typeof pref === 'string' ? pref : pref && typeof pref === 'object' ? pref.source : undefined;
    const chosen = candidates.find((c) => c.source === chosenSource);
    const byRank = [...candidates].sort((a, b) => rank.get(a.source) - rank.get(b.source))[0];
    const winner = chosen || byRank;
    const others = candidates.filter((c) => c !== winner);
    const decidedByOrder = forceExternal || [winner, ...others].every((c) => explicit.includes(c.source));
    const by = chosen ? 'choice' : decidedByOrder ? 'order' : 'default';

    // A pinned choice goes stale when a candidate's content differs from what was chosen against, or a new candidate appeared.
    let changed = [];
    if (chosen && pref && typeof pref === 'object' && pref.digests && typeof pref.digests === 'object') {
      changed = candidates.filter((c) => pref.digests[c.source] !== c.digest).map((c) => c.source);
    }
    const stale = changed.length > 0;

    entries.push({ name: winner.name, source: winner.source, absolutePath: winner.absolutePath });
    for (const c of others) {
      const same = c.digest !== null && c.digest === winner.digest;
      if (same) identical.push({ name: c.name, kept: winner.source, dropped: c.source });
      else collisions.push({ name: c.name, kept: winner.source, dropped: c.source, by, ...(by === 'choice' ? { preferred: true } : {}), ...(stale ? { stale: true } : {}) });
    }
    clashes.push({
      name: winner.name, winner: winner.source, by, stale, changed,
      candidates: candidates.map((c) => ({ source: c.source, primary: c.primary, winner: c === winner, absolutePath: c.absolutePath, digest: c.digest, identical: c !== winner && c.digest !== null && c.digest === winner.digest })),
    });
  }

  return { entries, collisions, identical, clashes, rejected, order };
}

function key(name) { return IS_WIN ? name.toLowerCase() : name; }

/**
 * Materialize the view by staging and swapping, so a failure mid-way never
 * leaves projects pointing at an empty or partial directory.
 */
function materializeView(viewDir, entries) {
  const parent = path.dirname(viewDir);
  fs.mkdirSync(parent, { recursive: true });
  const staging = `${viewDir}.staging-${process.pid}`;
  const old = `${viewDir}.old-${process.pid}`;
  const linkType = IS_WIN ? 'junction' : 'symlink';

  // Validate the existing view BEFORE touching anything: it must be missing or a directory of links only.
  const current = inspectDestination(viewDir);
  if (current.kind === 'link' || current.kind === 'file') {
    throw refused('VIEW_SHAPE', `${viewDir} is a ${current.kind}, expected a directory of links; refusing to replace it`);
  }
  if (current.kind === 'directory') assertLinksOnly(viewDir, current.entries);

  removeLinksDir(staging);
  fs.mkdirSync(staging);
  try {
    for (const e of entries) createDirectoryLink(e.absolutePath, path.join(staging, e.name), linkType);
  } catch (err) {
    removeLinksDir(staging);
    throw err;
  }

  if (current.kind === 'directory') fs.renameSync(viewDir, old);
  fs.renameSync(staging, viewDir);
  if (current.kind === 'directory') removeLinksDir(old);
  return { linked: entries.length };
}

/** Read-only check that every entry of dir is a link. */
function assertLinksOnly(dir, entries) {
  for (const name of entries) {
    const p = path.join(dir, name);
    if (inspectDestination(p).kind !== 'link') {
      throw refused('VIEW_SHAPE', `${p} is not a link; the view must contain only links. Move it out by hand before rebuilding.`);
    }
  }
}

/** Remove a directory that must contain only links. Validates first, so a bad entry aborts before any removal. */
function removeLinksDir(dir) {
  const st = inspectDestination(dir);
  if (st.kind === 'missing') return;
  if (st.kind !== 'directory') throw refused('VIEW_SHAPE', `${dir} is not a directory`);
  assertLinksOnly(dir, st.entries);
  for (const name of st.entries) removeLinkOnly(path.join(dir, name));
  fs.rmdirSync(dir);
}

module.exports = { computeView, materializeView, removeLinksDir };
