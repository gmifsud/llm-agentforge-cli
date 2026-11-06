#!/usr/bin/env node
/**
 * repo.js — External skill repository manager for agentforge.
 *
 * Manages registration, syncing, and merging of external skill repositories
 * into a unified merged-skills directory. Cross-platform (Windows, macOS, Linux).
 *
 * Usage:
 *   node repo.js add <url-or-path> [--name <name>] [--branch <branch>]
 *   node repo.js remove <name>
 *   node repo.js list
 *   node repo.js sync [--force] [--vault <path>]
 */

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const os = require('os');

// ─── Paths ──────────────────────────────────────────────────────────────────────
const AGENTFORGE_DIR = path.join(os.homedir(), '.agentforge');
const REPOS_JSON = path.join(AGENTFORGE_DIR, 'repos.json');
const REPOS_CACHE = path.join(AGENTFORGE_DIR, 'repos');
const MERGED_SKILLS = path.join(AGENTFORGE_DIR, 'merged-skills');

const IS_WINDOWS = process.platform === 'win32';

// ─── Logging ────────────────────────────────────────────────────────────────────
const c = {
  cyan:   s => `\x1b[36m${s}\x1b[0m`,
  green:  s => `\x1b[32m${s}\x1b[0m`,
  yellow: s => `\x1b[33m${s}\x1b[0m`,
  red:    s => `\x1b[31m${s}\x1b[0m`,
  grey:   s => `\x1b[90m${s}\x1b[0m`,
};
const step = msg => console.log(c.cyan(`→ ${msg}`));
const ok   = msg => console.log(c.green(`✓ ${msg}`));
const warn = msg => console.log(c.yellow(`! ${msg}`));
const err  = msg => console.log(c.red(`✗ ${msg}`));

// ─── Config helpers ─────────────────────────────────────────────────────────────
function ensureDir(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function loadConfig() {
  if (!fs.existsSync(REPOS_JSON)) return { repositories: [] };
  try {
    return JSON.parse(fs.readFileSync(REPOS_JSON, 'utf8'));
  } catch {
    warn('repos.json is corrupt, starting fresh');
    return { repositories: [] };
  }
}

function saveConfig(config) {
  ensureDir(AGENTFORGE_DIR);
  fs.writeFileSync(REPOS_JSON, JSON.stringify(config, null, 2) + '\n', 'utf8');
}

// ─── Git helpers ────────────────────────────────────────────────────────────────
function isGitUrl(str) {
  return /^(https?:\/\/|git@|ssh:\/\/)/.test(str);
}

function gitClone(url, dest, branch) {
  const branchArg = branch ? `--branch ${branch}` : '';
  execSync(`git clone --depth 1 ${branchArg} "${url}" "${dest}"`, { stdio: 'inherit' });
}

function gitPull(dir) {
  execSync('git pull --ff-only', { cwd: dir, stdio: 'inherit' });
}

function deriveNameFromUrl(urlOrPath) {
  let name = path.basename(urlOrPath);
  // Strip .git suffix
  name = name.replace(/\.git$/, '');
  return name;
}

// ─── Skill discovery ────────────────────────────────────────────────────────────
/**
 * Discovers skills in a repository root.
 * Prefers .claude-plugin/plugin.json manifest; falls back to SKILL.md scanning.
 * Returns an array of { name, absolutePath }.
 */
function discoverSkills(repoRoot) {
  const skills = [];
  const pluginJson = path.join(repoRoot, '.claude-plugin', 'plugin.json');

  if (fs.existsSync(pluginJson)) {
    // Read the manifest
    try {
      const manifest = JSON.parse(fs.readFileSync(pluginJson, 'utf8'));
      if (Array.isArray(manifest.skills)) {
        for (const relPath of manifest.skills) {
          const absPath = path.resolve(repoRoot, relPath);
          if (fs.existsSync(absPath)) {
            skills.push({ name: path.basename(absPath), absolutePath: absPath });
          }
        }
        return skills;
      }
    } catch {
      warn(`Failed to parse ${pluginJson}, falling back to SKILL.md scan`);
    }
  }

  // Fallback: scan for SKILL.md files (up to depth 4)
  scanForSkillMd(repoRoot, 0, 4, skills);
  return skills;
}

function scanForSkillMd(dir, depth, maxDepth, results) {
  if (depth > maxDepth) return;
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch { return; }

  for (const entry of entries) {
    if (entry.name === 'node_modules' || entry.name === '.git' || entry.name === 'deprecated') continue;
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      // Check if this directory contains a SKILL.md
      const skillMd = path.join(fullPath, 'SKILL.md');
      if (fs.existsSync(skillMd)) {
        results.push({ name: entry.name, absolutePath: fullPath });
      } else {
        scanForSkillMd(fullPath, depth + 1, maxDepth, results);
      }
    }
  }
}

// ─── Symlink / junction helpers ─────────────────────────────────────────────────
function createLink(target, linkPath) {
  // Remove existing link/dir at linkPath
  try {
    const stat = fs.lstatSync(linkPath);
    if (stat) fs.rmSync(linkPath, { recursive: true, force: true });
  } catch {
    // Doesn't exist — fine
  }

  if (IS_WINDOWS) {
    // Use 'junction' type — no admin required, fast native call
    fs.symlinkSync(target, linkPath, 'junction');
  } else {
    fs.symlinkSync(target, linkPath);
  }
}

// ─── Vault root resolution ──────────────────────────────────────────────────────
function resolveVaultRoot(cliVault) {
  if (cliVault) return cliVault;
  if (process.env.AGENTFORGE_VAULT_ROOT) return process.env.AGENTFORGE_VAULT_ROOT;
  if (IS_WINDOWS) return 'C:\\Repos\\LLM\\llm-skill-vault\\skills';
  return path.join(os.homedir(), 'repos/LLM/llm-skill-vault/skills');
}

// ─── Commands ───────────────────────────────────────────────────────────────────

function cmdAdd(urlOrPath, opts) {
  step('agentforge repo add');

  const name = opts.name || deriveNameFromUrl(urlOrPath);
  const type = isGitUrl(urlOrPath) ? 'git' : 'local';
  const branch = opts.branch || 'main';

  // Validate local path exists
  if (type === 'local') {
    const resolved = path.resolve(urlOrPath);
    if (!fs.existsSync(resolved)) {
      err(`Local path does not exist: ${resolved}`);
      process.exit(1);
    }
    urlOrPath = resolved;
  }

  const config = loadConfig();

  // Check for duplicates
  const existing = config.repositories.find(r => r.name === name);
  if (existing) {
    err(`Repository "${name}" is already registered (${existing.url_or_path})`);
    process.exit(1);
  }

  config.repositories.push({
    name,
    url_or_path: urlOrPath,
    type,
    branch: type === 'git' ? branch : undefined,
  });

  saveConfig(config);
  ok(`registered ${type} repo "${name}" (${urlOrPath})`);
  console.log(c.grey('  Run "agentforge repo sync" to clone and merge skills'));
}

function cmdRemove(name) {
  step('agentforge repo remove');

  const config = loadConfig();
  const idx = config.repositories.findIndex(r => r.name === name);
  if (idx === -1) {
    err(`Repository "${name}" is not registered`);
    process.exit(1);
  }

  const repo = config.repositories[idx];

  // Remove cached clone if it's a git repo
  const cachePath = path.join(REPOS_CACHE, name);
  if (repo.type === 'git' && fs.existsSync(cachePath)) {
    fs.rmSync(cachePath, { recursive: true, force: true });
    ok(`deleted cached clone at ${cachePath}`);
  }

  // Remove the repo from config
  config.repositories.splice(idx, 1);
  saveConfig(config);
  ok(`unregistered repo "${name}"`);

  // Rebuild merged-skills to remove stale symlinks
  console.log(c.grey('  Rebuilding merged-skills...'));
  cmdSync({ force: false, vault: null });
}

function cmdList() {
  step('agentforge repo list');
  const config = loadConfig();

  if (config.repositories.length === 0) {
    console.log('  No repositories registered.');
    console.log(c.grey('  Use "agentforge repo add <url-or-path>" to register one.'));
    return;
  }

  for (const repo of config.repositories) {
    const typeTag = repo.type === 'git' ? c.cyan('[git]') : c.green('[local]');
    let status = '';

    if (repo.type === 'git') {
      const cachePath = path.join(REPOS_CACHE, repo.name);
      status = fs.existsSync(cachePath) ? c.green(' (cloned)') : c.yellow(' (not synced)');
    } else {
      status = fs.existsSync(repo.url_or_path) ? c.green(' (exists)') : c.red(' (missing!)');
    }

    console.log(`  ${typeTag} ${repo.name}${status}`);
    console.log(c.grey(`       ${repo.url_or_path}${repo.branch ? ' @ ' + repo.branch : ''}`));

    // Show skill count if discoverable
    const repoRoot = repo.type === 'git' ? path.join(REPOS_CACHE, repo.name) : repo.url_or_path;
    if (fs.existsSync(repoRoot)) {
      const skills = discoverSkills(repoRoot);
      console.log(c.grey(`       ${skills.length} skills discovered`));
    }
  }
}

function cmdSync(opts) {
  step('agentforge repo sync');

  const config = loadConfig();
  const vaultRoot = resolveVaultRoot(opts.vault);
  const forceExternal = opts.force || false;

  // Validate vault
  if (!fs.existsSync(vaultRoot)) {
    err(`Vault root not found: ${vaultRoot}`);
    process.exit(1);
  }

  console.log(`  Vault   : ${vaultRoot}`);
  console.log(`  Merged  : ${MERGED_SKILLS}`);
  console.log(`  Repos   : ${config.repositories.length} registered`);
  if (forceExternal) console.log(c.yellow('  Mode    : --force (external skills take priority)'));
  console.log('');

  // Step 1: Clone/pull git repos
  for (const repo of config.repositories) {
    if (repo.type !== 'git') continue;

    const cachePath = path.join(REPOS_CACHE, repo.name);
    ensureDir(REPOS_CACHE);

    if (fs.existsSync(cachePath)) {
      step(`pulling ${repo.name}...`);
      try {
        gitPull(cachePath);
        ok(`updated ${repo.name}`);
      } catch (e) {
        warn(`pull failed for ${repo.name}: ${e.message}`);
      }
    } else {
      step(`cloning ${repo.name}...`);
      try {
        gitClone(repo.url_or_path, cachePath, repo.branch);
        ok(`cloned ${repo.name}`);
      } catch (e) {
        err(`clone failed for ${repo.name}: ${e.message}`);
        continue;
      }
    }
  }

  // Step 2: Discover vault skills
  step('scanning vault skills...');
  const vaultSkills = new Map();
  let vaultEntries;
  try {
    vaultEntries = fs.readdirSync(vaultRoot, { withFileTypes: true });
  } catch (e) {
    err(`Cannot read vault: ${e.message}`);
    process.exit(1);
  }

  for (const entry of vaultEntries) {
    if (!entry.isDirectory()) continue;
    const skillPath = path.join(vaultRoot, entry.name);
    vaultSkills.set(entry.name, skillPath);
  }
  ok(`${vaultSkills.size} vault skills`);

  // Step 3: Discover external skills
  const externalSkills = new Map(); // name → { absolutePath, repoName }
  let collisions = 0;

  for (const repo of config.repositories) {
    const repoRoot = repo.type === 'git' ? path.join(REPOS_CACHE, repo.name) : repo.url_or_path;
    if (!fs.existsSync(repoRoot)) {
      warn(`skipping ${repo.name}: path not found (${repoRoot})`);
      continue;
    }

    const skills = discoverSkills(repoRoot);
    step(`${repo.name}: ${skills.length} skills discovered`);

    for (const skill of skills) {
      // Check vault collision
      if (vaultSkills.has(skill.name)) {
        if (forceExternal) {
          warn(`${skill.name}: external (${repo.name}) overrides vault skill`);
        } else {
          // vault wins — skip silently (log at debug level)
          collisions++;
          continue;
        }
      }

      // Check external-to-external collision
      if (externalSkills.has(skill.name)) {
        const prev = externalSkills.get(skill.name);
        warn(`${skill.name}: already provided by ${prev.repoName}, skipping ${repo.name}`);
        continue;
      }

      externalSkills.set(skill.name, { absolutePath: skill.absolutePath, repoName: repo.name });
    }
  }

  if (collisions > 0) {
    warn(`${collisions} external skills skipped (same name as vault skills; use --force to override)`);
  }

  // Step 4: Build merged-skills directory
  step('building merged-skills directory...');

  // Wipe and recreate
  if (fs.existsSync(MERGED_SKILLS)) {
    fs.rmSync(MERGED_SKILLS, { recursive: true, force: true });
  }
  ensureDir(MERGED_SKILLS);

  let linked = 0;

  // Link vault skills (unless overridden by --force)
  for (const [name, absPath] of vaultSkills) {
    if (forceExternal && externalSkills.has(name)) continue; // external takes priority
    const linkPath = path.join(MERGED_SKILLS, name);
    createLink(absPath, linkPath);
    linked++;
  }

  // Link external skills
  for (const [name, info] of externalSkills) {
    const linkPath = path.join(MERGED_SKILLS, name);
    if (forceExternal || !vaultSkills.has(name)) {
      createLink(info.absolutePath, linkPath);
      linked++;
    }
  }

  ok(`merged-skills built: ${linked} skills linked`);
  console.log(c.grey(`  ${vaultSkills.size} from vault + ${externalSkills.size} from external repos`));
  console.log('');
  ok('sync complete');
  console.log(c.grey(`  agentforge will auto-detect ${MERGED_SKILLS} as vault root`));
}

// ─── Argument parsing ───────────────────────────────────────────────────────────
function parseArgs() {
  const args = process.argv.slice(2);
  if (args.length === 0) {
    showHelp();
    process.exit(0);
  }

  const action = args[0];
  const opts = { name: null, branch: null, force: false, vault: null };
  const positional = [];

  for (let i = 1; i < args.length; i++) {
    switch (args[i]) {
      case '--name':   opts.name = args[++i]; break;
      case '--branch': opts.branch = args[++i]; break;
      case '--force':  opts.force = true; break;
      case '--vault':  opts.vault = args[++i]; break;
      case '--help':
      case '-h':
        showHelp();
        process.exit(0);
        break;
      default:
        if (!args[i].startsWith('-')) positional.push(args[i]);
        else { err(`Unknown option: ${args[i]}`); process.exit(2); }
    }
  }

  return { action, positional, opts };
}

function showHelp() {
  console.log(`
agentforge repo — external skill repository manager

Usage:
  node repo.js add <url-or-path> [--name <name>] [--branch <branch>]
  node repo.js remove <name>
  node repo.js list
  node repo.js sync [--force] [--vault <path>]

Options:
  --name      Custom name for the repo (default: derived from URL/path)
  --branch    Git branch to clone (default: main)
  --force     During sync, let external skills override vault skills
  --vault     Override vault root path

Config:  ${REPOS_JSON}
Cache:   ${REPOS_CACHE}
Merged:  ${MERGED_SKILLS}
`);
}

// ─── Main ───────────────────────────────────────────────────────────────────────
const { action, positional, opts } = parseArgs();

switch (action) {
  case 'add':
    if (positional.length === 0) { err('Usage: repo add <url-or-path>'); process.exit(2); }
    cmdAdd(positional[0], opts);
    break;
  case 'remove':
    if (positional.length === 0) { err('Usage: repo remove <name>'); process.exit(2); }
    cmdRemove(positional[0]);
    break;
  case 'list':
    cmdList();
    break;
  case 'sync':
    cmdSync(opts);
    break;
  default:
    err(`Unknown action: ${action}`);
    showHelp();
    process.exit(2);
}
