'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { refused } = require('../domain/errors');

const IS_WIN = process.platform === 'win32';

function normalizeForCompare(p) {
  const r = path.resolve(p);
  return IS_WIN ? r.toLowerCase().replace(/[\\/]+$/, '') : r.replace(/\/+$/, '');
}

/** Physical path if it exists, otherwise the lexical resolution. */
function realOrResolved(p) {
  try { return fs.realpathSync.native(p); } catch { return path.resolve(p); }
}

function samePath(a, b) {
  return normalizeForCompare(realOrResolved(a)) === normalizeForCompare(realOrResolved(b));
}

/** Lexical containment: child is root or below it. */
function isWithinLexical(root, child) {
  const rel = path.relative(path.resolve(root), path.resolve(child));
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

/** Containment after resolving links (catches symlink escapes). */
function isWithinResolved(root, child) {
  return isWithinLexical(realOrResolved(root), realOrResolved(child));
}

/**
 * Normalized observation of a destination. The planner works on these; it never
 * touches the filesystem itself.
 *   { kind: 'missing' }
 *   { kind: 'link', target, resolvedTarget?, broken }
 *   { kind: 'directory', entries: string[] }
 *   { kind: 'file' }
 */
function inspectDestination(p) {
  let st;
  try { st = fs.lstatSync(p); } catch { return { kind: 'missing' }; }
  if (st.isSymbolicLink()) {
    let target;
    try { target = fs.readlinkSync(p); } catch { target = undefined; }
    let resolvedTarget;
    let broken = false;
    try {
      resolvedTarget = fs.realpathSync.native(p);
      if (!fs.statSync(resolvedTarget).isDirectory()) broken = true;
    } catch {
      broken = true;
    }
    return { kind: 'link', target, resolvedTarget, broken };
  }
  if (st.isDirectory()) {
    let entries = [];
    try { entries = fs.readdirSync(p); } catch { /* unreadable: treat as empty */ }
    return { kind: 'directory', entries };
  }
  return { kind: 'file' };
}

/**
 * Remove a link (symlink or junction) without ever recursing into its target.
 * Refuses anything that is not a reparse point.
 */
function removeLinkOnly(p) {
  const st = fs.lstatSync(p);
  if (!st.isSymbolicLink()) {
    throw refused('NOT_A_LINK', `${p} is not a link; refusing to remove it with removeLinkOnly`);
  }
  try {
    fs.unlinkSync(p);
  } catch (e) {
    if (e.code === 'EPERM' || e.code === 'EISDIR') fs.rmdirSync(p); // directory symlink / junction on Windows
    else throw e;
  }
}

/** Create a directory link of the given type. */
function createDirectoryLink(source, dest, linkType) {
  if (linkType === 'junction') {
    if (!IS_WIN) throw refused('LINK_TYPE', 'junction is only available on Windows');
    fs.symlinkSync(path.resolve(source), dest, 'junction');
  } else if (linkType === 'symlink') {
    fs.symlinkSync(path.resolve(source), dest, IS_WIN ? 'dir' : undefined);
  } else {
    throw refused('LINK_TYPE', `unknown link type "${linkType}"`);
  }
}

module.exports = {
  IS_WIN,
  samePath,
  realOrResolved,
  isWithinLexical,
  isWithinResolved,
  inspectDestination,
  removeLinkOnly,
  createDirectoryLink,
};
