'use strict';
/**
 * Adopting a skills folder that holds its own skills ("not managed here").
 *
 * Nothing of the owner's is moved, replaced or edited. The library's skills that the folder lacks are
 * copied in beside the owner's, and a marker beside the folder records exactly which names Agentforge
 * added, so a later Refresh copy replaces only those. A folder skill with the same name as a library
 * skill stays as it is and the library's is not copied. The folder is deliberately NOT added to .gitignore:
 * it holds the owner's own skills, which may be committed; only the marker (a path on this machine) is.
 */
const fs = require('node:fs');
const path = require('node:path');
const { inspectDestination, IS_WIN } = require('../infra/fs-inspect');
const { MARKER, markerPath, fingerprint, readMarker } = require('../deployment/copy-state');

const key = (name) => (IS_WIN ? name.toLowerCase() : name);

/**
 * Read-only and cheap (no digests). Sorts what is in a skills folder into the owner's own skills, skills that
 * share a name with a library skill (the owner's stays), and other entries; and lists the library skills the
 * folder lacks. The dashboard catalogue uses it too, so a page and a plan can never disagree about a folder.
 */
function classifyFolder({ folder, entries, libraryNames }) {
  const inLibrary = new Set(libraryNames.map(key));
  const present = new Set(entries.map(key));
  const own = [], shared = [];
  let others = 0;
  for (const entry of [...entries].sort()) {
    if (!fs.existsSync(path.join(folder, entry, 'SKILL.md'))) { others++; continue; }
    (inLibrary.has(key(entry)) ? shared : own).push(entry);
  }
  return { own, shared, others, incoming: libraryNames.filter((n) => !present.has(key(n))) };
}

/** Read-only. Returns { ok, conflicts, own, shared, incoming, others, actions, notes }. */
function planAdopt({ projectRoot, target, libraryRoot }) {
  const root = path.resolve(projectRoot);
  const dotDir = path.join(root, target.dir);
  const folder = path.join(dotDir, 'skills');
  const out = { ok: false, conflicts: [], folder, own: [], shared: [], incoming: [], others: 0, actions: [], notes: [] };

  const lib = inspectDestination(libraryRoot);
  if (!(lib.kind === 'directory' || (lib.kind === 'link' && !lib.broken))) { out.conflicts.push(`The library at ${libraryRoot} has not been built yet. Rebuild it first.`); return out; }
  const dest = inspectDestination(folder);
  if (dest.kind === 'missing') { out.conflicts.push(`${target.dir}/skills does not exist: there is no skills folder to adopt.`); return out; }
  if (dest.kind !== 'directory') { out.conflicts.push(`${target.dir}/skills is not an ordinary folder (${dest.kind}), so there is nothing of its own to adopt.`); return out; }
  if (readMarker(dotDir)) { out.conflicts.push(`${target.dir}/skills is already managed here. Use Refresh copy to bring it up to date.`); return out; }

  const fp = fingerprint(libraryRoot);
  const found = classifyFolder({ folder, entries: dest.entries, libraryNames: fp.names });
  Object.assign(out, { own: found.own, shared: found.shared, incoming: found.incoming, others: found.others });

  out.actions.push({
    kind: 'copy-entries', destination: folder, source: libraryRoot, entries: out.incoming, kept: dest.entries.length,
    marker: { file: markerPath(dotDir), data: { mode: 'copy', source: libraryRoot, fingerprint: fp.fingerprint, names: out.incoming } },
  });
  const ignoreFile = path.join(root, '.gitignore');
  const existing = fs.existsSync(ignoreFile) ? fs.readFileSync(ignoreFile, 'utf8').split(/\r?\n/).map((l) => l.trim()) : [];
  const line = `${target.dir}/${MARKER}`;
  if (!existing.includes(line) && !existing.includes(`${target.dir}/`)) out.actions.push({ kind: 'append-gitignore', destination: ignoreFile, lines: [line] });
  out.ok = true;
  return out;
}

module.exports = { planAdopt, classifyFolder };
