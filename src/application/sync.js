'use strict';

const { loadRegistry, loadConfig, resolvePrimarySource } = require('../infra/paths');
const { fetchSources, cacheRootFor } = require('./sources');
const { computeView, materializeView } = require('../deployment/build-view');
const { readLock, revisionLookup, snapshot, writeLock, diffLock } = require('./lock');
const { materializeKept } = require('../deployment/kept');
const { buildSets } = require('./sets');

/**
 * What the library holds right now, worked out from the sources on disk, without building anything:
 * the same view `repo sync` would build. Sets are resolved against it.
 */
function computeLibrary({ paths, env, cliVault, forceExternal = false }) {
  const config = loadConfig(paths);
  const primaryRoot = resolvePrimarySource({ cliVault, env, paths, config });
  return libraryFrom({ paths, config, primaryRoot, forceExternal });
}

/** The view from an already loaded config and resolved primary source, reading the registry as it is now. */
function libraryFrom({ paths, config, primaryRoot, forceExternal }) {
  const registry = loadRegistry(paths);
  const view = computeView({
    primaryRoot,
    repos: registry.repositories,
    cacheRootFor: (repo) => cacheRootFor(paths, repo),
    forceExternal,
    preferences: config.preferences,
    sourcePriority: config.sourcePriority,
    kept: config.kept || [],
    keptDir: paths.keptDir,
  });
  return { config, primaryRoot, registry, view };
}

/**
 * repo sync = fetch (optional) → compute view → materialize (unless dry run) → build every set from it.
 * Returns { primaryRoot, fetch: [...], kept: { built, droppedLinks, missing, blocked }, view: { entries, collisions, rejected }, lock, sets, linked? }.
 */
function syncView({ paths, env, cliVault, forceExternal = false, fetch = true, dryRun = false, git }) {
  // Config and the primary source are checked before any fetch, so a bad one refuses before a clone is touched.
  const config = loadConfig(paths);
  const primaryRoot = resolvePrimarySource({ cliVault, env, paths, config });
  const fetchResults = fetch ? fetchSources({ paths, git }) : [];
  const { registry, view } = libraryFrom({ paths, config, primaryRoot, forceExternal });
  // What the library holds now, read from disk, against the record of the last build. A dry run reports it without recording it.
  const previous = readLock(paths);
  const skills = snapshot(view.entries, revisionLookup({ repos: registry.repositories, git, rootFor: (repo) => cacheRootFor(paths, repo) }));
  const result = { primaryRoot, viewDir: paths.mergedSkills, fetch: fetchResults, view, lock: { previousBuiltAt: previous ? previous.builtAt : null, changes: diffLock(previous, skills) } };
  const keptResult = { built: view.kept.map((k) => k.name), droppedLinks: [], missing: view.keptMissing.map((k) => k.name), blocked: view.keptBlocked.map((k) => ({ name: k.name, reason: k.reason })) };
  result.kept = keptResult;
  if (!dryRun) {
    // Kept copies first: the library links to them, and a refusal here leaves the old library as it was.
    Object.assign(keptResult, materializeKept(paths.keptDir, view.kept));
    result.linked = materializeView(paths.mergedSkills, view.entries).linked;
    // The record describes a build that happened, so it is written after it. Failing to write it never fails the build.
    try { writeLock(paths, skills); } catch (e) { result.lock.error = e.message; }
  }
  // Every set is rebuilt with the library, from the same winners, so a set is never behind it.
  result.sets = buildSets({ paths, entries: view.entries, dryRun });
  return result;
}

module.exports = { syncView, computeLibrary };
