'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { isWithinLexical, isWithinResolved } = require('../infra/fs-inspect');

const SKIP_DIRS = new Set(['node_modules', '.git', 'deprecated', '.agentforge-no-hooks']);
const DEFAULT_MAX_DEPTH = 4;

/**
 * A skill root is a directory, inside the source root (lexically and after
 * resolving links), that contains SKILL.md.
 */
function validateSkillRoot(sourceRoot, candidate) {
  const abs = path.resolve(sourceRoot, candidate);
  if (!isWithinLexical(sourceRoot, abs)) return { ok: false, reason: 'outside source root (lexical)' };
  let st;
  try { st = fs.statSync(abs); } catch { return { ok: false, reason: 'does not exist' }; }
  if (!st.isDirectory()) return { ok: false, reason: 'not a directory' };
  if (!isWithinResolved(sourceRoot, abs)) return { ok: false, reason: 'outside source root (resolved link)' };
  if (!fs.existsSync(path.join(abs, 'SKILL.md'))) return { ok: false, reason: 'no SKILL.md' };
  return { ok: true, absolutePath: abs };
}

/**
 * Discover skills under a source root.
 * Prefers .claude-plugin/plugin.json; falls back to scanning for SKILL.md.
 * Every candidate, from either path, goes through validateSkillRoot.
 * Returns { skills: [{ name, absolutePath, relativePath }], rejected: [{ path, reason }] }
 */
function discoverSkills(sourceRoot, { maxDepth = DEFAULT_MAX_DEPTH, manifest = true } = {}) {
  const root = path.resolve(sourceRoot);
  const skills = [];
  const rejected = [];
  const seen = new Set();

  const accept = (abs) => {
    const key = abs.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    skills.push({ name: path.basename(abs), absolutePath: abs, relativePath: path.relative(root, abs) });
  };

  if (manifest) {
    const manifestPath = path.join(root, '.claude-plugin', 'plugin.json');
    if (fs.existsSync(manifestPath)) {
      let parsed;
      try { parsed = JSON.parse(fs.readFileSync(manifestPath, 'utf8')); } catch (e) {
        rejected.push({ path: manifestPath, reason: `unreadable manifest: ${e.message}` });
      }
      if (parsed && Array.isArray(parsed.skills)) {
        for (const rel of parsed.skills) {
          if (typeof rel !== 'string') { rejected.push({ path: String(rel), reason: 'not a string' }); continue; }
          const v = validateSkillRoot(root, rel);
          if (v.ok) accept(v.absolutePath); else rejected.push({ path: rel, reason: v.reason });
        }
        if (skills.length > 0) return { skills, rejected };
      }
    }
  }

  scan(root, root, 0, maxDepth, accept, rejected);
  return { skills, rejected };
}

function scan(root, dir, depth, maxDepth, accept, rejected) {
  if (depth > maxDepth) return;
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const entry of entries) {
    if (SKIP_DIRS.has(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isSymbolicLink()) {
      // Do not follow links during a scan: a link can point anywhere.
      rejected.push({ path: full, reason: 'symbolic link skipped during scan' });
      continue;
    }
    if (!entry.isDirectory()) continue;
    if (fs.existsSync(path.join(full, 'SKILL.md'))) {
      const v = validateSkillRoot(root, full);
      if (v.ok) accept(v.absolutePath); else rejected.push({ path: full, reason: v.reason });
    } else {
      scan(root, full, depth + 1, maxDepth, accept, rejected);
    }
  }
}

module.exports = { discoverSkills, validateSkillRoot };
