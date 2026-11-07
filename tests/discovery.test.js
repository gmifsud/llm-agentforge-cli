'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { discoverSkills } = require('../src/discovery/discover-skills');
const { tempRoot, makeVault, mkLink } = require('./helpers');

test('manifest entries outside the source root are rejected', (t) => {
  const root = tempRoot(t);
  const outside = makeVault(root, 'outside', ['secret']);
  const repo = makeVault(root, 'repo', ['good']);
  fs.mkdirSync(path.join(repo, '.claude-plugin'));
  fs.writeFileSync(path.join(repo, '.claude-plugin', 'plugin.json'), JSON.stringify({
    skills: ['./good', '../outside/secret', path.join(outside, 'secret'), './missing'],
  }));
  const { skills, rejected } = discoverSkills(repo);
  assert.deepEqual(skills.map((s) => s.name), ['good']);
  assert.equal(rejected.length, 3);
  assert.ok(rejected.every((r) => /outside|exist/.test(r.reason)));
});

test('a directory without SKILL.md is not a skill, even at the vault top level', (t) => {
  const root = tempRoot(t);
  const vault = makeVault(root, 'vault', ['a', 'b']);
  fs.mkdirSync(path.join(vault, 'notes'));
  fs.writeFileSync(path.join(vault, 'README.md'), 'x');
  const { skills } = discoverSkills(vault, { maxDepth: 1, manifest: false });
  assert.deepEqual(skills.map((s) => s.name).sort(), ['a', 'b']);
});

test('a link inside a source is never followed during a scan', (t) => {
  const root = tempRoot(t);
  const outside = makeVault(root, 'outside', ['leak']);
  const repo = makeVault(root, 'repo', ['real']);
  mkLink(outside, path.join(repo, 'linked'));
  const { skills, rejected } = discoverSkills(repo);
  assert.deepEqual(skills.map((s) => s.name), ['real']);
  assert.ok(rejected.some((r) => r.reason.includes('symbolic link')));
});

test('scan finds nested skills and skips node_modules and deprecated', (t) => {
  const root = tempRoot(t);
  const repo = path.join(root, 'repo');
  for (const p of ['skills/eng/tdd', 'skills/prod/caveman', 'node_modules/pkg/sk', 'deprecated/old']) {
    fs.mkdirSync(path.join(repo, p), { recursive: true });
    fs.writeFileSync(path.join(repo, p, 'SKILL.md'), '#');
  }
  const { skills } = discoverSkills(repo);
  assert.deepEqual(skills.map((s) => s.name).sort(), ['caveman', 'tdd']);
});
