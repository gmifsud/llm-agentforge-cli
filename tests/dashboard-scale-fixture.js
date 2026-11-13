'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { tempRoot, makeVault, mkLink } = require('./helpers');

/**
 * A workspace shaped like a large one: many projects spread over a few parent folders, each wired to a
 * different mix of agents, and a vault of `skillCount` skills. For measuring and for scale tests.
 */
function scaleFixture(t, { projects = 150, skillCount = 370, groups = ['LLM', 'Work', 'Clients', 'Tools'] } = {}) {
  const root = tempRoot(t);
  const homedir = path.join(root, 'home');
  const names = Array.from({ length: skillCount }, (_, i) => `skill-${String(i).padStart(3, '0')}`);
  const vault = makeVault(root, 'vault', names);
  fs.mkdirSync(path.join(homedir, '.agentforge'), { recursive: true });
  fs.writeFileSync(path.join(homedir, '.agentforge', 'repos.json'), JSON.stringify({ repositories: [] }));
  fs.writeFileSync(path.join(homedir, '.agentforge', 'config.json'), JSON.stringify({ vaultRoot: vault }));
  const merged = path.join(homedir, '.agentforge', 'merged-skills');
  fs.mkdirSync(merged);
  for (const name of names) mkLink(path.join(vault, name), path.join(merged, name));

  const paths = [];
  for (let i = 0; i < projects; i++) {
    const dir = path.join(root, 'repos', groups[i % groups.length], `project-${String(i).padStart(3, '0')}`);
    fs.mkdirSync(path.join(dir, '.claude'), { recursive: true });
    fs.mkdirSync(path.join(dir, '.codex'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'CLAUDE.md'), '# Project');
    // A spread of states: linked to the library, linked to the vault only, or not wired.
    if (i % 3 === 0) mkLink(merged, path.join(dir, '.claude', 'skills'));
    else if (i % 3 === 1) mkLink(vault, path.join(dir, '.claude', 'skills'));
    if (i % 4 === 0) mkLink(merged, path.join(dir, '.codex', 'skills'));
    paths.push(dir);
  }
  return { root, homedir, vault, merged, projects: paths, options: { homedir, vault, projects: paths, env: {} } };
}
module.exports = { scaleFixture };
