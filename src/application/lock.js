'use strict';
/**
 * The lock record: what the library held at its last build, in ~/.agentforge/lock.json.
 *
 * For each skill, the source it came from, that source's revision (Git sources) and a digest of its content.
 * The library is made of links, so a source can change a skill's content without any link changing; this record is
 * how a rebuild, and the dashboard, can say which skills changed since the last build.
 *
 * It is a record to compare with, never an input. The library is always computed from the sources on disk. A missing,
 * corrupt or foreign lock simply means "no earlier build on record"; it is never repaired, trusted or used to skip work.
 */
const fs = require('node:fs');
const path = require('node:path');
const { atomicWrite } = require('../infra/paths');
const { digestSkill } = require('../discovery/skill-digest');

const VERSION = 1;
const lockFile = (paths) => path.join(paths.agentforgeDir, 'lock.json');

/** The last build's record, or null when there is none or it cannot be understood. */
function readLock(paths) {
  let parsed;
  try { parsed = JSON.parse(fs.readFileSync(lockFile(paths), 'utf8')); } catch { return null; }
  if (!parsed || parsed.version !== VERSION || !parsed.skills || typeof parsed.skills !== 'object' || Array.isArray(parsed.skills)) return null;
  return parsed;
}

/** Look up a source's revision by name. Only Git sources have one; a Git client that fails gives none, not a failed build. */
function revisionLookup({ repos, git, rootFor }) {
  return (name) => {
    const repo = repos.find((r) => r.name === name);
    if (!repo || repo.type !== 'git' || !git || typeof git.revision !== 'function') return null;
    try { return git.revision(rootFor(repo)) || null; } catch { return null; }
  };
}

/**
 * What the library would hold now, read from disk: for each skill (by name, in name order, so the file is the same on
 * every run) its source, the source's revision, and a digest of its content. A skill that cannot be read has no digest.
 */
function snapshot(entries, revisionFor = () => null) {
  const skills = {};
  const sorted = [...entries].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  for (const e of sorted) {
    let digest = null;
    try { digest = digestSkill(e.absolutePath).digest; } catch { /* unreadable or too large: recorded as unknown */ }
    skills[e.name] = { source: e.source, revision: revisionFor(e.source) || null, digest };
  }
  return skills;
}

/** Record a build. `skills` is a snapshot of what was built. */
function writeLock(paths, skills, now = new Date()) {
  fs.mkdirSync(paths.agentforgeDir, { recursive: true });
  atomicWrite(lockFile(paths), JSON.stringify({ version: VERSION, builtAt: now.toISOString(), skills }, null, 2) + '\n');
}

/**
 * What changed between the last build's record and a snapshot of now.
 *   added    in the library now, not in the record
 *   removed  in the record, not in the library now
 *   changed  the content differs (or, when a digest is unknown, the source's revision does)
 *   moved    the same content, now from another source
 * `first` is true when there is no record, so there is nothing to compare with.
 */
function diffLock(previous, next) {
  const out = { first: !previous, added: [], removed: [], changed: [], moved: [] };
  if (!previous) return out;
  const was = previous.skills;
  for (const [name, now] of Object.entries(next)) {
    const before = was[name];
    if (!before) { out.added.push(name); continue; }
    const known = Boolean(before.digest && now.digest);
    if (known && before.digest !== now.digest) out.changed.push(name);
    else if (!known && before.revision !== now.revision) out.changed.push(name);
    else if (before.source !== now.source) out.moved.push(name);
  }
  for (const name of Object.keys(was)) if (!(name in next)) out.removed.push(name);
  for (const k of ['added', 'removed', 'changed', 'moved']) out[k].sort();
  return out;
}

const hasChanges = (d) => d.added.length + d.removed.length + d.changed.length + d.moved.length > 0;

module.exports = { lockFile, readLock, revisionLookup, snapshot, writeLock, diffLock, hasChanges };
