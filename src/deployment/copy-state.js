'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { digestSkill } = require('../discovery/skill-digest');

/**
 * A copied skills folder does not follow the library, so it needs a record of
 * what it was copied from. The marker sits beside the skills folder, not inside
 * it, so no agent tool mistakes it for a skill:
 *
 *   <project>/.agents/.agentforge-skills.json
 *   { mode: 'copy', source, fingerprint, names: [...], copiedAt }
 *
 * `names` are the entries Agentforge put there. Anything else in the folder is
 * the user's and is never touched by a refresh.
 */
const MARKER = '.agentforge-skills.json';

function markerPath(dotDir) { return path.join(dotDir, MARKER); }

/** Content identity of a whole library folder: every skill name with its digest. */
function fingerprint(root) {
  const names = [];
  const parts = [];
  for (const name of fs.readdirSync(root).sort()) {
    const dir = path.join(root, name);
    if (!fs.existsSync(path.join(dir, 'SKILL.md'))) continue;
    names.push(name);
    parts.push(`${name}:${digestSkill(dir).digest}`);
  }
  return { fingerprint: createHash('sha256').update(parts.join('\n')).digest('hex'), names };
}

function readMarker(dotDir) {
  try {
    const m = JSON.parse(fs.readFileSync(markerPath(dotDir), 'utf8'));
    return m && m.mode === 'copy' && Array.isArray(m.names) && typeof m.fingerprint === 'string' ? m : null;
  } catch { return null; }
}

/**
 * Is the copy in <dotDir>/skills still what the library holds?
 * Returns { managed: false } for a folder Agentforge did not copy, otherwise
 * { managed: true, state: 'fresh' | 'stale', copiedAt, names }.
 */
function copyState(dotDir, libraryRoot) {
  const marker = readMarker(dotDir);
  if (!marker) return { managed: false };
  let current;
  try { current = fingerprint(libraryRoot).fingerprint; } catch { return { managed: true, state: 'stale', copiedAt: marker.copiedAt, names: marker.names }; }
  return { managed: true, state: current === marker.fingerprint ? 'fresh' : 'stale', copiedAt: marker.copiedAt, names: marker.names };
}

module.exports = { MARKER, markerPath, fingerprint, readMarker, copyState };
