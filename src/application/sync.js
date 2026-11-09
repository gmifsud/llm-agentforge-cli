'use strict';

const { loadRegistry, loadConfig, resolvePrimarySource } = require('../infra/paths');
const { fetchSources, cacheRootFor } = require('./sources');
const { computeView, materializeView } = require('../deployment/build-view');

/**
 * repo sync = fetch (optional) → compute view → materialize (unless dry run).
 * Returns { primaryRoot, fetch: [...], view: { entries, collisions, rejected }, linked? }.
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
  });
  const result = { primaryRoot, viewDir: paths.mergedSkills, fetch: fetchResults, view };
  if (!dryRun) result.linked = materializeView(paths.mergedSkills, view.entries).linked;
  return result;
}

module.exports = { syncView };
