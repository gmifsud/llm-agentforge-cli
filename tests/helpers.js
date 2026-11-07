'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createDirectoryLink } = require('../src/infra/fs-inspect');

const IS_WIN = process.platform === 'win32';

/** Fresh temp root per test; everything (fake home, vault, project) lives under it. */
function tempRoot(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentforge-test-'));
  t.after(() => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ } });
  return dir;
}

function makeVault(root, name, skills) {
  const vault = path.join(root, name);
  fs.mkdirSync(vault, { recursive: true });
  for (const s of skills) {
    fs.mkdirSync(path.join(vault, s), { recursive: true });
    fs.writeFileSync(path.join(vault, s, 'SKILL.md'), `# ${s}\n`);
  }
  return vault;
}

/** Directory link using the platform-native type (junction on Windows, symlink elsewhere). */
function mkLink(source, dest) {
  createDirectoryLink(source, dest, IS_WIN ? 'junction' : 'symlink');
}

function snapshot(dir) {
  const out = [];
  (function walk(d, rel) {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const r = path.join(rel, e.name);
      if (e.isSymbolicLink()) out.push(`${r} -> ${fs.readlinkSync(path.join(d, e.name))}`);
      else if (e.isDirectory()) { out.push(`${r}/`); walk(path.join(d, e.name), r); }
      else out.push(`${r} ${fs.statSync(path.join(d, e.name)).size}`);
    }
  })(dir, '');
  return out.sort();
}

module.exports = { IS_WIN, tempRoot, makeVault, mkLink, snapshot };
