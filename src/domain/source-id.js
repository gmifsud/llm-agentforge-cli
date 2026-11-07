'use strict';

const { usage } = require('./errors');

const SOURCE_ID_RE = /^[a-z0-9][a-z0-9_.-]{0,63}$/i;

/**
 * A source ID doubles as the cache directory name, so it must never be able to
 * leave the cache root. Conservative character set, no dot-only names.
 */
function validateSourceId(id) {
  if (typeof id !== 'string' || id.length === 0) throw usage('source ID is required');
  if (id === '.' || id === '..' || !SOURCE_ID_RE.test(id)) {
    throw usage(`invalid source ID "${id}": use letters, digits, "_", "-", "." (max 64 chars, no leading dot)`);
  }
  return id;
}

/** Derive a candidate ID from a URL or path; the result is still validated by the caller. */
function deriveSourceId(urlOrPath) {
  const trimmed = String(urlOrPath).replace(/[\\/]+$/, '');
  let base = trimmed.split(/[\\/:]/).pop() || '';
  base = base.replace(/\.git$/i, '');
  return base;
}

const URL_SCHEMES = /^(https?:\/\/|ssh:\/\/|git@[^/:]+:)/i;

function isGitUrl(str) {
  return URL_SCHEMES.test(String(str));
}

module.exports = { validateSourceId, deriveSourceId, isGitUrl };
