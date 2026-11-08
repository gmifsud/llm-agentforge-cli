'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { ReadService, localPath } = require('../dashboard/server/read-service');
const { LIMITS } = require('../dashboard/server/constants');
const { computeView } = require('../src/deployment/build-view');
const { fixture, contentSnapshot } = require('./dashboard-fixtures');
const { tempRoot, makeVault, mkLink } = require('./helpers');

test('dashboard reads preserve all managed bytes and links; merge matches core', t => {
  const f = fixture(t), before = contentSnapshot(f.root), s = new ReadService(f.options);
  const context = s.context(), catalog = s.refresh();
  const expected = computeView({ primaryRoot: f.vault, repos: f.repos, cacheRootFor: () => '' });
  assert.deepEqual(catalog.winnerIds.map(id => catalog.skills.find(x => x.id === id).name).sort(), expected.entries.map(x => x.name).sort());
  assert.equal(catalog.collisions.length, 1);
  const selected = catalog.skills.find(x => x.id === catalog.collisions[0].winnerId);
  assert.equal(selected.sourceId, catalog.sources[0].id);
  assert.match(s.document(selected.id, catalog.generation).text, /frontend-design/);
  const project = s.project(context.projects[0].id);
  assert.equal(project.targets[0].match, 'matches');
  assert.equal(project.targets[1].match, 'differs');
  assert.equal(project.targets[2].match, 'unknown');
  s.refresh();
  assert.deepEqual(contentSnapshot(f.root), before);
});

test('dashboard missing registry stays absent; absent source counts are null', t => {
  const root = tempRoot(t), vault = makeVault(root, 'vault', ['one']);
  const service = new ReadService({ homedir: root, vault, projects: [root], env: {} });
  service.context(); const c = service.refresh(); service.document(c.skills[0].id, c.generation); service.project(service.projects[0].id);
  assert.equal(fs.existsSync(path.join(root, '.agentforge')), false);
  const f = fixture(t);
  fs.writeFileSync(f.registry, JSON.stringify({ repositories: [{ name: 'remote', type: 'git', url_or_path: 'https://user:secret@example.com/repo?token=secret' }] }));
  const c2 = new ReadService(f.options).refresh();
  assert.equal(c2.sources[1].count, null); assert.equal(c2.sources[1].state, 'not-fetched');
  assert.equal(JSON.stringify(c2).includes('secret'), false); assert.equal(c2.mergeAvailable, false);
});

test('dashboard failed refresh invalidates document access and preserves last catalogue', t => {
  const f = fixture(t), s = new ReadService(f.options), c = s.refresh();
  fs.writeFileSync(f.registry, '{bad');
  assert.throws(() => s.refresh(), { code: 'CONFIG_CORRUPT' });
  assert.equal(s.catalog.generation, c.generation);
  assert.throws(() => s.document(c.skills[0].id, c.generation), { status: 409 });
  fs.writeFileSync(f.registry, JSON.stringify({ repositories: f.repos }));
  const next = s.refresh();
  assert.throws(() => s.document(c.skills[0].id, c.generation), { status: 409 });
  assert.throws(() => s.document('unknown', next.generation), { status: 404 });
});

test('dashboard separates primary vault identity from a registered source named vault', t => {
  const f = fixture(t); f.repos[0].name = 'vault';
  fs.writeFileSync(f.registry, JSON.stringify({ repositories: f.repos }));
  const c = new ReadService(f.options).refresh();
  assert.notEqual(c.sources[0].id, c.sources[1].id);
  assert.equal(c.skills.find(x => x.id === c.collisions[0].winnerId).sourceId, c.sources[0].id);
});

test('dashboard document limits, traversal IDs and external directory links fail closed', t => {
  const f = fixture(t), s = new ReadService(f.options), c = s.refresh();
  const skill = c.skills.find(x => x.sourceId === c.sources[0].id);
  const file = path.join(f.vault, skill.relativePath, 'SKILL.md');
  fs.writeFileSync(file, Buffer.alloc(LIMITS.documentBytes + 1));
  assert.throws(() => s.document(skill.id, c.generation), { status: 413 });
  assert.throws(() => s.document('../../secret', c.generation), { status: 404 });
  const outside = makeVault(f.root, 'outside', ['escape']);
  mkLink(outside, path.join(f.source, 'escape-link'));
  const next = s.refresh();
  assert.ok(next.rejected.some(r => r.reason.includes('symbolic link')));
  assert.equal(next.skills.some(x => x.name === 'escape'), false);
  assert.throws(() => localPath('\\\\wsl.localhost\\Ubuntu\\home'), { status: 403 });
  assert.throws(() => localPath('//server/share'), { status: 403 });
});

test('dashboard manifest escape is visible and text payloads stay literal', t => {
  const f = fixture(t);
  fs.mkdirSync(path.join(f.source, '.claude-plugin'));
  fs.writeFileSync(path.join(f.source, '.claude-plugin', 'plugin.json'), JSON.stringify({ skills: ['../vault/sql-review', './browser-testing'] }));
  const payload = '<script>fetch("https://example.com")</script>';
  fs.writeFileSync(path.join(f.source, 'browser-testing', 'SKILL.md'), payload);
  const s = new ReadService(f.options), c = s.refresh();
  assert.ok(c.rejected.some(r => r.reason.includes('outside')));
  const skill = c.skills.find(x => x.name === 'browser-testing');
  assert.equal(s.document(skill.id, c.generation).text, payload);
});

test('dashboard missing primary vault never produces a successful merge', t => {
  const f = fixture(t), s = new ReadService({ ...f.options, vault: path.join(f.root, 'missing') });
  const c = s.refresh(); assert.equal(c.mergeAvailable, false); assert.equal(c.status, 'partial');
  assert.equal(c.sources[0].count, null); assert.ok(c.skills.length > 0);
});

test('dashboard refuses symlinked skill files and network-targeting directory links', t => {
  const f = fixture(t), linkSkill = path.join(f.source, 'linked-skill');
  fs.mkdirSync(linkSkill);
  // This machine supports file symlinks; a failure is a real validation gap, not a silent skip.
  fs.symlinkSync(path.join(f.source, 'browser-testing', 'SKILL.md'), path.join(linkSkill, 'SKILL.md'), 'file');
  const service = new ReadService(f.options), c = service.refresh();
  const linked = c.skills.find(s => s.name === 'linked-skill');
  assert.throws(() => service.document(linked.id, c.generation), { status: 403 });
  if (process.platform === 'win32') {
    const network = path.join(f.root, 'network-link');
    fs.symlinkSync('\\\\wsl.localhost\\UnopenedDistribution\\skills', network, 'dir');
    assert.throws(() => localPath(network), { status: 403 });
  }
});

test('cached Git source reports local revision and ignores inherited Git overrides', t => {
  const f = fixture(t), cached = path.join(f.homedir, '.agentforge', 'repos', 'cached');
  const gitDir = path.join(cached, '.git');
  fs.mkdirSync(path.join(gitDir, 'objects'), { recursive: true });
  fs.mkdirSync(path.join(gitDir, 'refs', 'heads'), { recursive: true });
  fs.writeFileSync(path.join(gitDir, 'HEAD'), 'ref: refs/heads/main\n');
  fs.writeFileSync(path.join(gitDir, 'refs', 'heads', 'main'), '1234567890abcdef1234567890abcdef12345678\n');
  fs.mkdirSync(path.join(cached, 'cached-skill'));
  fs.writeFileSync(path.join(cached, 'cached-skill', 'SKILL.md'), '# Cached');
  fs.writeFileSync(f.registry, JSON.stringify({ repositories: [{ name: 'cached', type: 'git', url_or_path: 'https://example.com/cached' }] }));
  const before = contentSnapshot(f.root), old = process.env.GIT_DIR;
  process.env.GIT_DIR = path.join(f.root, 'wrong-git-dir');
  try {
    const c = new ReadService(f.options).refresh();
    assert.match(c.sources[1].revision, /^1234567/);
    assert.equal(c.sources[1].count, 1);
    assert.deepEqual(contentSnapshot(f.root), before);
  } finally { if (old === undefined) delete process.env.GIT_DIR; else process.env.GIT_DIR = old; }
});

test('guarded project inspector refuses nested non-local skill documents', t => {
  if (process.platform !== 'win32') return;
  const f = fixture(t), nested = path.join(f.vault, 'group', 'nested');
  fs.mkdirSync(nested, { recursive: true });
  fs.symlinkSync('\\\\wsl.localhost\\UnopenedDistribution\\SKILL.md', path.join(nested, 'SKILL.md'), 'file');
  const service = new ReadService(f.options);
  assert.throws(() => service.project(service.projects[0].id), { status: 403 });
});
