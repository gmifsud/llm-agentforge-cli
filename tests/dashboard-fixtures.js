'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { tempRoot, makeVault, mkLink } = require('./helpers');

function fixture(t) {
  const root = tempRoot(t);
  const homedir = path.join(root, 'home');
  const vault = makeVault(root, 'vault', ['frontend-design', 'sql-review']);
  const source = makeVault(root, 'source', ['frontend-design', 'browser-testing']);
  const project = path.join(root, 'project');
  fs.mkdirSync(path.join(project, '.claude'), { recursive: true });
  fs.mkdirSync(path.join(project, '.codex'), { recursive: true });
  fs.mkdirSync(path.join(homedir, '.agentforge'), { recursive: true });
  fs.writeFileSync(path.join(project, 'CLAUDE.md'), '# Project');
  mkLink(vault, path.join(project, '.claude', 'skills'));
  mkLink(source, path.join(project, '.codex', 'skills'));
  const registry = path.join(homedir, '.agentforge', 'repos.json');
  const repos = [{ name: 'frontend-lab', type: 'local', url_or_path: source }];
  fs.writeFileSync(registry, JSON.stringify({ repositories: repos }));
  fs.writeFileSync(path.join(homedir, '.agentforge', 'config.json'), JSON.stringify({ vaultRoot: vault }));
  const merged = path.join(homedir, '.agentforge', 'merged-skills');
  fs.mkdirSync(merged);
  mkLink(path.join(vault, 'frontend-design'), path.join(merged, 'frontend-design'));
  mkLink(path.join(source, 'browser-testing'), path.join(merged, 'browser-testing'));
  return { root, homedir, vault, source, project, registry, repos, options: { homedir, vault, projects: [project], env: {} } };
}

function contentSnapshot(root) {
  const result = [];
  function visit(dir, prefix = '') {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, e.name), relative = path.join(prefix, e.name);
      if (e.isSymbolicLink()) result.push([relative, 'link', fs.readlinkSync(full)]);
      else if (e.isDirectory()) { result.push([relative, 'directory']); visit(full, relative); }
      else result.push([relative, createHash('sha256').update(fs.readFileSync(full)).digest('hex')]);
    }
  }
  visit(root);
  return result.sort((a, b) => a[0].localeCompare(b[0]));
}
module.exports = { fixture, contentSnapshot };
