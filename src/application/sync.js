'use strict';

const { loadRegistry, loadConfig, resolvePrimarySource } = require('../infra/paths');
const { fetchSources, cacheRootFor } = require('./sources');
const { computeView, materializeView } = require('../deployment/build-view');
const { readLock, revisionLookup, snapshot, writeLock, diffLock } = require('./lock');
const { buildSets } = require('./sets');

/**
 * What the library holds right now, worked out from the sources on disk, without building anything:
 * the same view `repo sync` would build. Sets are resolved against it.
 */
function computeLibrary({ paths, env, cliVault, forceExternal = false }) {
  const config = loadConfig(paths);
  const primaryRoot = resolvePrimarySource({ cliVault, env, paths, config });
  const registry = loadRegistry(paths);
  const view = computeView({
    primaryRoot,
    repos: registry.repositories,
    cacheRootFor: (repo) => cacheRootFor(paths, repo),
    forceExternal,
    preferences: config.preferences,
    sourcePriority: config.sourcePriority,
  });
  return { config, primaryRoot, registry, view };
}

/**
 * repo sync = fetch (optional) → compute view → materialize (unless dry run) → build every set from it.
 * Returns { primaryRoot, fetch: [...], view: { entries, collisions, rejected }, lock, sets, linked? }.
 */
function syncView({ paths, env, cliVault, forceExternal = false, fetch = true, dryRun = false, git }) {
  const config = loadConfig(paths);
  const primaryRoot = resolvePrimarySource({ cliVault, env, paths, config });
  const fetchResults = fetch ? fetchSources({ paths, git }) : [];
  const registry = loadRegistry(paths);
  const view = computeView({
    primaryRoot,
    repos: registry.repositories,
    cacheRootFor: (repo) => cacheRootFor(paths, repo),
    forceExternal,
    preferences: config.preferences,
    sourcePriority: config.sourcePriority,
  });
  // What the library holds now, read from disk, against the record of the last build. A dry run reports it without recording it.
  const previous = readLock(paths);
  const skills = snapshot(view.entries, revisionLookup({ repos: registry.repositories, git, rootFor: (repo) => cacheRootFor(paths, repo) }));
  const result = { primaryRoot, viewDir: paths.mergedSkills, fetch: fetchResults, view, lock: { previousBuiltAt: previous ? previous.builtAt : null, changes: diffLock(previous, skills) } };
  if (!dryRun) {
    result.linked = materializeView(paths.mergedSkills, view.entries).linked;
    // The record describes a build that happened, so it is written after it. Failing to write it never fails the build.
    try { writeLock(paths, skills); } catch (e) { result.lock.error = e.message; }
  }
  // Every set is rebuilt with the library, from the same winners, so a set is never behind it.
  result.sets = buildSets({ paths, entries: view.entries, dryRun });
  return result;
}

module.exports = { syncView, computeLibrary };
