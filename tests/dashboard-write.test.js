'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { createDashboard } = require('../dashboard/server/http');
const { WriteService } = require('../dashboard/server/write-service');
const { ReadService } = require('../dashboard/server/read-service');
const { inspectDestination } = require('../src/infra/fs-inspect');
const { fixture, contentSnapshot } = require('./dashboard-fixtures');
const { makeVault, mkLink } = require('./helpers');

const ok = (svc, change) => { const p = svc.preview(change); assert.equal(p.ok, true, JSON.stringify(p.conflicts)); return p; };
const apply = (svc, ...changes) => svc.apply(changes).results;

test('attach a folder, rebuild, choose a collision winner: library follows, CLI config agrees', t => {
  const f = fixture(t);
  const extra = makeVault(f.root, 'extra', ['sql-review', 'perf']);
  const svc = new WriteService(f.options);

  const attach = ok(svc, { kind: 'source.attach', args: { location: extra, name: 'extra' } });
  assert.ok(attach.lines.some(l => /2 skills found/.test(l.text)));
  assert.ok(attach.lines.some(l => /sql-review/.test(l.text) && l.tone === 'warn'), 'overlap with the vault is called out');

  const rebuild = ok(svc, { kind: 'library.rebuild' });
  assert.ok(rebuild.lines.some(l => /Add 1 skill: sql-review/.test(l.text)), 'diff against the built library before attach');

  const r = apply(svc, { kind: 'source.attach', args: { location: extra, name: 'extra' } }, { kind: 'library.rebuild' });
  assert.deepEqual(r.map(x => x.status), ['applied', 'applied']);
  const lib = path.join(f.homedir, '.agentforge', 'merged-skills');
  assert.deepEqual(fs.readdirSync(lib).sort(), ['browser-testing', 'frontend-design', 'perf', 'sql-review']);
  assert.equal(fs.realpathSync(path.join(lib, 'sql-review')).toLowerCase(), path.join(f.vault, 'sql-review').toLowerCase());

  const pref = apply(svc, { kind: 'library.prefer', args: { skill: 'sql-review', source: 'extra' } }, { kind: 'library.rebuild' });
  assert.deepEqual(pref.map(x => x.status), ['applied', 'applied']);
  assert.equal(fs.realpathSync(path.join(lib, 'sql-review')).toLowerCase(), path.join(extra, 'sql-review').toLowerCase());
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(f.homedir, '.agentforge', 'config.json'), 'utf8')), { vaultRoot: f.vault, preferences: { 'sql-review': 'extra' } });

  const reader = new ReadService(f.options);
  const c = reader.refresh();
  assert.equal(c.library.inSync, true);
  const col = c.collisions.find(x => x.name === 'sql-review');
  assert.equal(c.sources.find(s => s.id === col.preferredSourceId).key, 'extra');
  assert.equal(c.sources.find(s => s.id === c.skills.find(s => s.id === col.winnerId).sourceId).key, 'extra');

  apply(svc, { kind: 'library.prefer', args: { skill: 'sql-review' } });
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(f.homedir, '.agentforge', 'config.json'), 'utf8')), { vaultRoot: f.vault });
});

test('add a project, wire two agents to the library, repoint one that pointed elsewhere', t => {
  const f = fixture(t);
  const svc = new WriteService({ ...f.options, projects: [] });
  const proj = path.join(f.root, 'new-app'); fs.mkdirSync(proj);

  apply(svc, { kind: 'project.add', args: { path: proj } });
  const reader = new ReadService({ ...f.options, projects: [] });
  let c = reader.refresh();
  const entry = c.projects.find(p => p.project.path === proj);
  assert.equal(entry.project.origin, 'saved');
  assert.ok(entry.targets.every(x => x.feeds === 'none'));

  const wire = ok(svc, { kind: 'project.wire', args: { projectId: entry.project.id, targets: ['claude', 'gemini'] } });
  assert.ok(wire.lines.some(l => l.text === 'Link .claude/skills to the library'));
  assert.ok(wire.lines.some(l => l.text === 'Write CLAUDE.md'));
  assert.deepEqual(apply(svc, { kind: 'project.wire', args: { projectId: entry.project.id, targets: ['claude', 'gemini'] } }).map(r => r.status), ['applied']);
  c = reader.refresh();
  const wired = c.projects.find(p => p.project.path === proj).targets;
  assert.equal(wired.find(x => x.id === 'claude').feeds, 'library');
  assert.equal(wired.find(x => x.id === 'gemini').feeds, 'library');
  assert.equal(wired.find(x => x.id === 'codex').feeds, 'none');
  assert.match(fs.readFileSync(path.join(proj, '.gitignore'), 'utf8'), /\.claude\/skills/);

  // The fixture project has .claude/skills linked to the vault and .codex/skills linked to an external folder.
  const old = new ReadService(f.options).refresh().projects[0];
  assert.equal(old.targets.find(x => x.id === 'claude').feeds, 'vault');
  assert.equal(old.targets.find(x => x.id === 'codex').feeds, 'elsewhere');
  const svc2 = new WriteService(f.options);
  const refuse = svc2.preview({ kind: 'project.wire', args: { projectId: old.project.id, targets: ['codex'] } });
  assert.equal(refuse.ok, false);
  assert.match(refuse.conflicts[0], /Use Repoint/);
  const before = fs.readdirSync(f.source).sort();
  const repoint = ok(svc2, { kind: 'project.wire', args: { projectId: old.project.id, targets: ['codex'], repoint: true, writeDocs: false } });
  assert.ok(repoint.lines.some(l => l.tone === 'remove' && /That folder is not touched/.test(l.text)));
  assert.deepEqual(apply(svc2, { kind: 'project.wire', args: { projectId: old.project.id, targets: ['codex'], repoint: true, writeDocs: false } }).map(r => r.status), ['applied']);
  assert.deepEqual(fs.readdirSync(f.source).sort(), before, 'the folder the old link pointed at is untouched');
  assert.equal(new ReadService(f.options).refresh().projects[0].targets.find(x => x.id === 'codex').feeds, 'library');
});

test('changes stop at the first refusal; nothing after it runs', t => {
  const f = fixture(t);
  const svc = new WriteService(f.options);
  const before = contentSnapshot(f.root);
  const r = apply(svc,
    { kind: 'source.attach', args: { location: path.join(f.root, 'nope'), name: 'nope' } },
    { kind: 'library.rebuild' });
  assert.deepEqual(r.map(x => x.status), ['refused', 'skipped']);
  assert.deepEqual(contentSnapshot(f.root), before);
  assert.equal(svc.preview({ kind: 'source.attach', args: { location: 'relative\\path' } }).ok, false);
  assert.equal(svc.preview({ kind: 'source.attach', args: { location: f.vault, name: 'v2' } }).ok, false, 'the vault cannot be attached again');
  assert.equal(svc.preview({ kind: 'source.attach', args: { location: path.join(f.homedir, '.agentforge', 'merged-skills'), name: 'lib' } }).ok, false);
  assert.equal(svc.preview({ kind: 'nope.nope' }).ok, false);
  assert.equal(svc.preview({ kind: 'project.wire', args: { projectId: 'x'.repeat(64), targets: ['claude'] } }).ok, false);
  assert.equal(svc.preview({ kind: 'library.prefer', args: { skill: 'browser-testing', source: 'vault' } }).ok, false, 'only one source provides it');
});

test('a session project cannot be forgotten; a saved one can, and its folder is untouched', t => {
  const f = fixture(t);
  const svc = new WriteService(f.options);
  const session = new ReadService(f.options).refresh().projects[0].project;
  assert.equal(svc.preview({ kind: 'project.forget', args: { projectId: session.id } }).ok, false);
  const other = path.join(f.root, 'other'); fs.mkdirSync(other); fs.writeFileSync(path.join(other, 'keep.txt'), 'x');
  apply(svc, { kind: 'project.add', args: { path: other } });
  const saved = new ReadService(f.options).refresh().projects.find(p => p.project.path === other).project;
  assert.deepEqual(apply(svc, { kind: 'project.forget', args: { projectId: saved.id } }).map(r => r.status), ['applied']);
  assert.ok(fs.existsSync(path.join(other, 'keep.txt')));
  assert.equal(new ReadService(f.options).refresh().projects.some(p => p.project.path === other), false);
});

function post(url, route, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const target = new URL(url);
    const data = JSON.stringify(body);
    const req = http.request({ hostname: target.hostname, port: target.port, path: route, method: 'POST', headers: {
      'x-agentforge-read': '1', 'x-agentforge-write': '1', 'content-type': 'application/json', origin: url, ...headers } }, res => {
      let out = ''; res.on('data', c => out += c); res.on('end', () => resolve({ status: res.statusCode, body: out }));
    }); req.on('error', reject); req.end(data);
  });
}

test('HTTP: changes need same Origin, both headers and JSON; previews never write', async t => {
  const f = fixture(t);
  const assetRoot = path.join(f.root, 'ui'); fs.mkdirSync(assetRoot); fs.writeFileSync(path.join(assetRoot, 'index.html'), '<h1>x</h1>');
  const app = await createDashboard({ options: f.options, assetRoot }); t.after(() => app.close());
  const before = contentSnapshot(f.root);
  const change = { kind: 'library.rebuild' };
  for (const headers of [{ origin: 'https://evil.example' }, { origin: '' }, { 'sec-fetch-site': 'cross-site' }, { 'x-agentforge-write': '' }]) {
    assert.equal((await post(app.url, '/api/v1/changes/preview', { change }, headers)).status, 403, JSON.stringify(headers));
  }
  assert.equal((await post(app.url, '/api/v1/changes/preview', { change }, { 'content-type': 'text/plain' })).status, 415);
  assert.equal((await post(app.url, '/api/v1/changes/run', { change })).status, 405);
  const preview = await post(app.url, '/api/v1/changes/preview', { change });
  assert.equal(preview.status, 200);
  assert.equal(JSON.parse(preview.body).ok, true);
  assert.deepEqual(contentSnapshot(f.root), before, 'preview does not write');
  const applied = await post(app.url, '/api/v1/changes/apply', { changes: [change] });
  assert.equal(JSON.parse(applied.body).results[0].status, 'applied');
  assert.equal(inspectDestination(path.join(f.homedir, '.agentforge', 'merged-skills', 'sql-review')).kind, 'link');
});
