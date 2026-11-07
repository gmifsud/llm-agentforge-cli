'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { discoverSkills } = require('../discovery/discover-skills');
const { inspectDestination, removeLinkOnly, createDirectoryLink, IS_WIN } = require('../infra/fs-inspect');
const { refused } = require('../domain/errors');

/**
 * Compute the merged view: one link per exported skill name.
 * Pure: reads sources, returns { entries, collisions, rejected }.
 *   entries:    [{ name, source, absolutePath }]
 *   collisions: [{ name, kept, dropped }]
 */
function computeView({ primaryRoot, repos, cacheRootFor, forceExternal = false }) {
  const entries = new Map();
  const collisions = [];
  const rejected = [];

  const primary = discoverSkills(primaryRoot, { maxDepth: 1, manifest: false });
  rejected.push(...primary.rejected.map((r) => ({ source: 'vault', ...r })));
  for (const s of primary.skills) entries.set(key(s.name), { name: s.name, source: 'vault', absolutePath: s.absolutePath });

  for (const repo of repos) {
    const root = repo.type === 'git' ? cacheRootFor(repo) : repo.url_or_path;
    if (!fs.existsSync(root)) { rejected.push({ source: repo.name, path: root, reason: 'source path not found (not fetched?)' }); continue; }
    const found = discoverSkills(root);
    rejected.push(...found.rejected.map((r) => ({ source: repo.name, ...r })));
    for (const s of found.skills) {
      const k = key(s.name);
      const existing = entries.get(k);
      if (!existing) { entries.set(k, { name: s.name, source: repo.name, absolutePath: s.absolutePath }); continue; }
      if (existing.source === 'vault' && forceExternal) {
        collisions.push({ name: s.name, kept: repo.name, dropped: 'vault' });
        entries.set(k, { name: s.name, source: repo.name, absolutePath: s.absolutePath });
      } else {
        collisions.push({ name: s.name, kept: existing.source, dropped: repo.name });
      }
    }
  }

  return { entries: [...entries.values()], collisions, rejected };
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
