'use strict';

const path = require('node:path');
const fs = require('node:fs');
const { failure } = require('../domain/errors');

/**
 * Environment-specific defaults are resolved here, in one place, and passed in.
 * Use cases never read os.homedir() or process.env themselves, so tests can
 * point everything at a temp directory.
 */
function createPaths({ homedir, platform = process.platform, scriptDir }) {
  if (!homedir) throw new Error('createPaths: homedir is required');
  const agentforgeDir = path.join(homedir, '.agentforge');
  return Object.freeze({
    platform,
    homedir,
    scriptDir,
    agentforgeDir,
    reposJson: path.join(agentforgeDir, 'repos.json'),
    configJson: path.join(agentforgeDir, 'config.json'),
    reposCache: path.join(agentforgeDir, 'repos'),
    mergedSkills: path.join(agentforgeDir, 'merged-skills'),
    templatesDir: scriptDir ? path.join(scriptDir, 'templates') : undefined,
    defaultVaultRoot:
      platform === 'win32'
        ? 'D:\\Repos\\LLM\\llm-skill-vault\\skills'
        : path.join(homedir, 'repos/LLM/llm-skill-vault/skills'),
  });
}

// ─── repos.json (source registry) ────────────────────────────────────────────

const EMPTY_REGISTRY = () => ({ repositories: [] });

function loadRegistry(paths) {
  if (!fs.existsSync(paths.reposJson)) return EMPTY_REGISTRY();
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(paths.reposJson, 'utf8'));
  } catch (e) {
    // Fail closed: a corrupt registry must never be silently replaced by an empty one.
    throw failure('CONFIG_CORRUPT', `${paths.reposJson} is not valid JSON (${e.message}). Fix or move it; refusing to continue.`);
  }
  if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.repositories)) {
    throw failure('CONFIG_INVALID', `${paths.reposJson} must be an object with a "repositories" array`);
  }
  for (const r of parsed.repositories) {
    if (!r || typeof r.name !== 'string' || typeof r.url_or_path !== 'string' || !['git', 'local'].includes(r.type)) {
      throw failure('CONFIG_INVALID', `${paths.reposJson}: malformed repository entry ${JSON.stringify(r)}`);
    }
  }
  return parsed;
}

function saveRegistry(paths, registry) {
  fs.mkdirSync(paths.agentforgeDir, { recursive: true });
  atomicWrite(paths.reposJson, JSON.stringify(registry, null, 2) + '\n');
}

// ─── config.json (optional machine settings) ─────────────────────────────────

function loadConfig(paths) {
  if (!fs.existsSync(paths.configJson)) return {};
  try {
    const parsed = JSON.parse(fs.readFileSync(paths.configJson, 'utf8'));
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch (e) {
    throw failure('CONFIG_CORRUPT', `${paths.configJson} is not valid JSON (${e.message})`);
  }
}

function atomicWrite(file, content) {
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, content, 'utf8');
  fs.renameSync(tmp, file);
}

// ─── vault / deploy root resolution ──────────────────────────────────────────

/**
 * Root that init/link deploy from. Precedence:
 *   1. --vault
 *   2. AGENTFORGE_VAULT_ROOT
 *   3. config.json vaultRoot
 *   4. ~/.agentforge/merged-skills — only if a registry exists behind it
 *   5. platform default
 * Returns { root, origin, warnings[] }.
 */
function resolveDeployRoot({ cliVault, env = {}, paths, config = {} }) {
  const warnings = [];
  if (cliVault) return { root: path.resolve(cliVault), origin: 'cli', warnings };
  if (env.AGENTFORGE_VAULT_ROOT) return { root: env.AGENTFORGE_VAULT_ROOT, origin: 'env', warnings };
  if (config.vaultRoot) return { root: config.vaultRoot, origin: 'config', warnings };
  if (fs.existsSync(paths.mergedSkills)) {
    if (fs.existsSync(paths.reposJson)) return { root: paths.mergedSkills, origin: 'merged-view', warnings };
    warnings.push(`ignoring ${paths.mergedSkills}: no ${path.basename(paths.reposJson)} behind it (orphaned view). Run "agentforge repo sync" or delete it.`);
  }
  return { root: paths.defaultVaultRoot, origin: 'default', warnings };
}

/**
 * Primary source for "repo sync" (the personal vault). Never the merged view.
 */
function resolvePrimarySource({ cliVault, env = {}, paths, config = {} }) {
  const root = cliVault ? path.resolve(cliVault) : env.AGENTFORGE_VAULT_ROOT || config.vaultRoot || paths.defaultVaultRoot;
  if (path.resolve(root).toLowerCase() === path.resolve(paths.mergedSkills).toLowerCase()) {
    throw failure('VIEW_AS_SOURCE', `${root} is the merged view, not a source; pass the real vault with --vault`);
  }
  return root;
}

module.exports = {
  createPaths,
  loadRegistry,
  saveRegistry,
  loadConfig,
  atomicWrite,
  resolveDeployRoot,
  resolvePrimarySource,
};
