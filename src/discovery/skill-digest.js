'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { failure } = require('../domain/errors');

const SKIP = new Set(['.git', 'node_modules', '__pycache__', '.DS_Store', 'Thumbs.db']);
const DEFAULT_LIMITS = Object.freeze({ maxFiles: 2000, maxBytes: 20 * 1024 * 1024 });

const sha = (data) => createHash('sha256').update(data).digest('hex');

/** Text when the first 8 KiB holds no NUL byte. */
function isText(buffer) {
  return !buffer.subarray(0, 8192).includes(0);
}

/** Normalise text so the same skill hashes the same on Windows and Unix: no BOM, LF line endings. */
function normalise(buffer) {
  if (!isText(buffer)) return buffer;
  let text = buffer.toString('utf8');
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  return Buffer.from(text.replace(/\r\n?/g, '\n'), 'utf8');
}

/**
 * Content identity of one skill folder.
 *
 * The digest covers every file's relative path and normalised content. It does
 * NOT cover the folder's own name or location, so a copy under another name or
 * in another source has the same digest. Links inside the folder are recorded
 * by name (their presence matters) but never followed.
 *
 * Returns { digest, files: [{ path, size, sha, link? }], bytes }.
 */
function digestSkill(dir, limits = {}) {
  const { maxFiles, maxBytes } = { ...DEFAULT_LIMITS, ...limits };
  const root = path.resolve(dir);
  const files = [];
  let bytes = 0;

  (function walk(current, rel) {
    const entries = fs.readdirSync(current, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const entry of entries) {
      if (SKIP.has(entry.name)) continue;
      const relPath = rel ? `${rel}/${entry.name}` : entry.name;
      const full = path.join(current, entry.name);
      if (entry.isSymbolicLink()) {
        files.push({ path: relPath, size: 0, sha: sha(`link:${relPath}`), link: true });
      } else if (entry.isDirectory()) {
        walk(full, relPath);
      } else if (entry.isFile()) {
        const content = normalise(fs.readFileSync(full));
        bytes += content.length;
        if (bytes > maxBytes) throw failure('DIGEST_LIMIT', `${root} is larger than ${maxBytes} bytes; not hashing it`);
        files.push({ path: relPath, size: content.length, sha: sha(content) });
      }
      if (files.length > maxFiles) throw failure('DIGEST_LIMIT', `${root} has more than ${maxFiles} files; not hashing it`);
    }
  })(root, '');

  files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  const digest = sha(files.map((f) => `${f.sha}  ${f.path}\n`).join(''));
  return { digest, files, bytes };
}

module.exports = { digestSkill, DEFAULT_LIMITS };
