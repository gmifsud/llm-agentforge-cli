'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { validateSourceId, deriveSourceId, isGitUrl } = require('../domain/source-id');
const { loadRegistry, saveRegistry } = require('../infra/paths');
const { isWithinLexical, isWithinResolved, inspectDestination } = require('../infra/fs-inspect');
const { discoverSkills } = require('../discovery/discover-skills');
const { usage, refused } = require('../domain/errors');

const CACHE_MARKER = '.agentforge-cache-root';

function cacheRootFor(paths, repo) {
  validateSourceId(repo.name);
  return path.join(paths.reposCache, repo.name);
}

function sourceRootFor(paths, repo) {
  return repo.type === 'git' ? cacheRootFor(paths, repo) : repo.url_or_path;
}

function addSource({ paths, urlOrPath, name, branch }) {
  if (!urlOrPath) throw usage('repo add <url-or-path> is required');
  const type = isGitUrl(urlOrPath) ? 'git' : 'local';
  const id = validateSourceId(name || deriveSourceId(urlOrPath));
  if (id.toLowerCase() === 'vault') throw usage('"vault" is reserved for your primary vault; give this source another name with --name');
  if (branch !== undefined && branch !== null) {
    if (typeof branch !== 'string' || branch.length === 0 || branch.startsWith('-')) throw usage(`invalid branch "${branch}"`);
  }

  let location = urlOrPath;
  if (type === 'local') {
    location = path.resolve(urlOrPath);
    const st = inspectDestination(location);
    if (st.kind === 'missing' || st.kind === 'file') throw usage(`local path does not exist or is not a directory: ${location}`);
    // A view is something Agentforge builds from sources, never one of them.
    if (isWithinLexical(paths.viewsDir, location)) throw refused('VIEW_AS_SOURCE', `${location} is a set, not a source`);
    if (isWithinLexical(paths.mergedSkills, location)) throw refused('VIEW_AS_SOURCE', `${location} is the library, not a source`);
  }

  const registry = loadRegistry(paths);
  const clash = registry.repositories.find((r) => r.name.toLowerCase() === id.toLowerCase());
  if (clash) throw refused('DUPLICATE_SOURCE', `source "${clash.name}" is already registered (${clash.url_or_path})`);

  const record = { name: id, url_or_path: location, type };
  if (type === 'git' && branch) record.branch = branch; // no branch → git chooses the remote default
  registry.repositories.push(record);
  saveRegistry(paths, registry);
  return record;
}

/**
 * Unregister a source. Deletes the cached clone only when it is a git source,
 * the path is inside the managed cache (lexically and resolved), the cache
 * root carries the marker, and the entry is an ordinary directory.
 * Never touches a registered local path. Never rebuilds the view.
 */
function removeSource({ paths, name }) {
  const id = validateSourceId(name);
  const registry = loadRegistry(paths);
  const idx = registry.repositories.findIndex((r) => r.name === id);
  if (idx === -1) throw usage(`source "${id}" is not registered`);
  const repo = registry.repositories[idx];

  let removedCache = false;
  if (repo.type === 'git') {
    const cachePath = cacheRootFor(paths, repo);
    const st = inspectDestination(cachePath);
    if (st.kind !== 'missing') {
      const marker = path.join(paths.reposCache, CACHE_MARKER);
      if (!fs.existsSync(marker)) throw refused('CACHE_UNMANAGED', `${paths.reposCache} has no ${CACHE_MARKER} marker; not deleting ${cachePath}`);
      if (st.kind !== 'directory') throw refused('CACHE_SHAPE', `${cachePath} is a ${st.kind}, expected an ordinary directory; not deleting`);
      if (!isWithinLexical(paths.reposCache, cachePath) || !isWithinResolved(paths.reposCache, cachePath) ||
          path.resolve(cachePath) === path.resolve(paths.reposCache)) {
        throw refused('CACHE_ESCAPE', `${cachePath} is not inside ${paths.reposCache}; not deleting`);
      }
      fs.rmSync(cachePath, { recursive: true, force: true });
      removedCache = true;
    }
  }

  registry.repositories.splice(idx, 1);
  saveRegistry(paths, registry);
  return { repo, removedCache };
}

function listSources({ paths, git }) {
  const registry = loadRegistry(paths);
  return registry.repositories.map((repo) => {
    const root = sourceRootFor(paths, repo);
    const exists = fs.existsSync(root);
    let skills = 0;
    let rejected = 0;
    if (exists) { const d = discoverSkills(root, repo.type === 'git' ? {} : {}); skills = d.skills.length; rejected = d.rejected.length; }
    return {
      ...repo,
      root,
      status: repo.type === 'git' ? (exists ? 'cloned' : 'not fetched') : exists ? 'exists' : 'missing',
      revision: exists && repo.type === 'git' && git ? git.revision(root) : undefined,
      skills,
      rejected,
    };
  });
}

/**
 * Clone or fast-forward every git source. Never builds the view.
 * Returns [{ name, status: 'cloned' | 'updated' | 'failed' | 'skipped', error? }].
 */
function fetchSources({ paths, git, only }) {
  const registry = loadRegistry(paths);
  const results = [];
  for (const repo of registry.repositories) {
    if (repo.type !== 'git') continue;
    if (only && repo.name !== only) { results.push({ name: repo.name, status: 'skipped' }); continue; }
    const cachePath = cacheRootFor(paths, repo);
    try {
      fs.mkdirSync(paths.reposCache, { recursive: true });
      const marker = path.join(paths.reposCache, CACHE_MARKER);
      if (!fs.existsSync(marker)) fs.writeFileSync(marker, 'Managed by agentforge. Entries here are disposable clones.\n');
      if (fs.existsSync(cachePath)) { git.pull(cachePath); results.push({ name: repo.name, status: 'updated', revision: git.revision(cachePath) }); }
      else { git.clone(repo.url_or_path, cachePath, repo.branch); results.push({ name: repo.name, status: 'cloned', revision: git.revision(cachePath) }); }
    } catch (e) {
      results.push({ name: repo.name, status: 'failed', error: e.message });
    }
  }
  return results;
}

module.exports = { addSource, removeSource, listSources, fetchSources, cacheRootFor, sourceRootFor, CACHE_MARKER };
