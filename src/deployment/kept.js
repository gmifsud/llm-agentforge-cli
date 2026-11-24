'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { inspectDestination } = require('../infra/fs-inspect');
const { rewriteFrontmatter } = require('../discovery/skill-lint');
const { refused, failure } = require('../domain/errors');

const MARKER = '.agentforge-kept';

/** The folders agentforge recorded in the marker, or null when the marker is missing or unreadable. */
function readMarker(dir) {
  try {
    const parsed = JSON.parse(fs.readFileSync(path.join(dir, MARKER), 'utf8'));
    return Array.isArray(parsed.folders) && parsed.folders.every((f) => typeof f === 'string') ? parsed.folders : null;
  } catch { return null; }
}

/**
 * Read-only check that `keptDir` holds only what agentforge put there: nothing, or exactly the
 * folders its marker lists (plus the marker). Anything else belongs to the user and is never replaced.
 */
function assertOurs(dir, current) {
  if (current.kind === 'missing') return;
  if (current.kind !== 'directory') throw refused('KEPT_SHAPE', `${dir} is a ${current.kind}, expected a folder of kept copies; refusing to replace it`);
  const marked = readMarker(dir);
  if (marked === null && current.entries.length === 0) return;
  if (marked === null) throw refused('KEPT_SHAPE', `${dir} has contents agentforge did not make (no ${MARKER} file); move them out by hand before rebuilding.`);
  const allowed = new Set([...marked, MARKER]);
  for (const name of current.entries) {
    if (!allowed.has(name)) throw refused('KEPT_SHAPE', `${path.join(dir, name)} is not a kept copy agentforge made; move it out by hand before rebuilding.`);
  }
}

/** True when `target` resolves to a place inside `root` (both real paths). Unresolvable targets are outside. */
function resolvesInside(target, root) {
  let real;
  try { real = fs.realpathSync.native(target); } catch { return false; }
  const rel = path.relative(root, real);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

/** Copy one original, never following links; links leading outside the original are dropped and listed. */
function copyOriginal({ name, originalPath: from, description }, to, droppedLinks) {
  // Copy from the real folder, so an original that is itself a link never makes the copy a link into it.
  const root = fs.realpathSync.native(from);
  fs.cpSync(root, to, {
    recursive: true,
    dereference: false,
    verbatimSymlinks: true,
    filter: (src) => {
      if (!fs.lstatSync(src).isSymbolicLink() || resolvesInside(src, root)) return true;
      droppedLinks.push({ name, path: path.relative(root, src) });
      return false;
    },
  });
  if (!fs.lstatSync(to).isDirectory()) throw refused('KEPT_SHAPE', `${to} was copied as a link, not a folder; refusing to write through it.`);
  const skillFile = path.join(to, 'SKILL.md');
  const text = fs.readFileSync(skillFile, 'utf8');
  // A SKILL.md that is a link is replaced by a plain file, so the rewrite can never land in the original.
  if (fs.lstatSync(skillFile).isSymbolicLink()) fs.unlinkSync(skillFile);
  fs.writeFileSync(skillFile, rewriteFrontmatter(text, { name, description }));
}

/**
 * Regenerate every kept copy as a real folder under `keptDir`, from the originals as they are now.
 * Built in kept.staging-<pid> and swapped in whole; the previous folder is restored if the swap fails.
 * Refuses (KEPT_SHAPE) rather than touch anything agentforge did not make.
 * Returns { built: names, droppedLinks: [{ name, path }], leftover? }: `leftover` is the previous folder when it could
 * not be removed after a successful swap. The new copies are live by then, so that never fails the build.
 */
function materializeKept(keptDir, kept) {
  const parent = path.dirname(keptDir);
  fs.mkdirSync(parent, { recursive: true });
  const staging = `${keptDir}.staging-${process.pid}`;
  const old = `${keptDir}.old-${process.pid}`;

  if (inspectDestination(old).kind !== 'missing') {
    throw refused('KEPT_BACKUP', `${old} already exists. Recover or move this previous folder before rebuilding; it will not be overwritten.`);
  }
  const current = inspectDestination(keptDir);
  assertOurs(keptDir, current);

  // A staging folder left by a crashed run of this process id is ours only if it carries the marker.
  const leftover = inspectDestination(staging);
  if (leftover.kind !== 'missing') {
    if (leftover.kind !== 'directory' || readMarker(staging) === null) throw refused('KEPT_SHAPE', `${staging} already exists and is not a staging folder agentforge made; move it out by hand.`);
    fs.rmSync(staging, { recursive: true, force: true });
  }

  const droppedLinks = [];
  const built = [];
  fs.mkdirSync(staging);
  try {
    for (const k of kept) {
      copyOriginal(k, path.join(staging, k.name), droppedLinks);
      built.push(k.name);
    }
    fs.writeFileSync(path.join(staging, MARKER), `${JSON.stringify({ folders: built })}\n`);
  } catch (err) {
    fs.rmSync(staging, { recursive: true, force: true });
    throw err;
  }

  if (current.kind === 'directory') fs.renameSync(keptDir, old);
  try {
    fs.renameSync(staging, keptDir);
  } catch (err) {
    if (current.kind === 'directory') {
      try { fs.renameSync(old, keptDir); }
      catch (recovery) {
        throw failure('KEPT_RECOVERY_FAILED', `Kept copies promotion failed (${err.message}) and restoring the previous folder failed (${recovery.message}). Previous folder: ${old}. Staged replacement: ${staging}. Recover these before rebuilding.`);
      }
    }
    fs.rmSync(staging, { recursive: true, force: true });
    throw err;
  }
  if (current.kind === 'directory') {
    try { fs.rmSync(old, { recursive: true, force: true }); }
    catch { return { built, droppedLinks, leftover: old }; }
  }
  return { built, droppedLinks };
}

module.exports = { materializeKept, KEPT_MARKER: MARKER };
