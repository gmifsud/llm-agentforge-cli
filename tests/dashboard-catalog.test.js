'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { createDashboard } = require('../dashboard/server/http');
const { ReadService } = require('../dashboard/server/read-service');
const { WriteService } = require('../dashboard/server/write-service');
const { addSource } = require('../src/application/sources');
const { createPaths } = require('../src/infra/paths');
const { fixture } = require('./dashboard-fixtures');
const { makeVault, mkLink } = require('./helpers');

// The fixture: vault has frontend-design + sql-review; the "frontend-lab" source has frontend-design + browser-testing.
const config = (f, extra) => fs.writeFileSync(path.join(f.homedir, '.agentforge', 'config.json'), JSON.stringify({ vaultRoot: f.vault, ...extra }));
const clash = (c, name = 'frontend-design') => c.collisions.find(x => x.name === name);
const srcOf = (c, skillId) => c.sources.find(s => s.id === c.skills.find(x => x.id === skillId).sourceId).key;

test('catalogue says what kind of clash each one is, and why its winner won', t => {
  const f = fixture(t);
  let c = new ReadService(f.options).refresh();
  assert.deepEqual({ kind: clash(c).kind, by: clash(c).by, stale: clash(c).stale }, { kind: 'default', by: 'default', stale: false });
  assert.equal(srcOf(c, clash(c).winnerId), 'vault');
  assert.deepEqual(c.sourceOrder.map(id => c.sources.find(s => s.id === id).key), ['vault', 'frontend-lab']);
  assert.equal(c.sourceOrderExplicit, false);

  config(f, { sourcePriority: ['frontend-lab', 'vault'] });
  c = new ReadService(f.options).refresh();
  assert.equal(clash(c).kind, 'order');
  assert.equal(srcOf(c, clash(c).winnerId), 'frontend-lab');
  assert.equal(c.sourceOrderExplicit, true);
  assert.deepEqual(c.sourceOrder.map(id => c.sources.find(s => s.id === id).key), ['frontend-lab', 'vault']);
});

test('identical copies are reported as identical; a pinned choice turns "changed" when a copy is edited', t => {
  const f = fixture(t);
  fs.copyFileSync(path.join(f.vault, 'frontend-design', 'SKILL.md'), path.join(f.source, 'frontend-design', 'SKILL.md'));
  let c = new ReadService(f.options).refresh();
  assert.equal(clash(c).kind, 'identical');
  assert.equal(clash(c).identicalIds.length, 1);

  fs.appendFileSync(path.join(f.source, 'frontend-design', 'SKILL.md'), 'lab edition\n');
  const w = new WriteService(f.options);
  assert.equal(w.apply([{ kind: 'library.prefer', args: { skill: 'frontend-design', source: 'frontend-lab' } }]).results[0].status, 'applied');
  c = new ReadService(f.options).refresh();
  assert.deepEqual({ kind: clash(c).kind, winner: srcOf(c, clash(c).winnerId) }, { kind: 'choice', winner: 'frontend-lab' });

  fs.appendFileSync(path.join(f.vault, 'frontend-design', 'SKILL.md'), 'vault edited later\n');
  c = new ReadService(f.options).refresh();
  assert.equal(clash(c).kind, 'changed');
  assert.equal(srcOf(c, clash(c).winnerId), 'frontend-lab', 'the choice still holds');
  assert.deepEqual(clash(c).changedSourceIds.map(id => c.sources.find(s => s.id === id).key), ['vault']);
});

test('catalogue health: rule problems, listing budget and personal skills that hide linked ones', t => {
  const f = fixture(t);
  fs.writeFileSync(path.join(f.vault, 'sql-review', 'SKILL.md'), '---\nname: something-else\ndescription: d\n---\n');
  fs.mkdirSync(path.join(f.homedir, '.claude', 'skills', 'browser-testing'), { recursive: true });
  fs.writeFileSync(path.join(f.homedir, '.claude', 'skills', 'browser-testing', 'SKILL.md'), '---\nname: browser-testing\ndescription: mine\n---\n');
  config(f, { listingBudgetChars: 30 });
  const c = new ReadService(f.options).refresh();
  assert.deepEqual(c.health.findings.map(x => `${x.skill}:${x.code}`), ['something-else:NAME_MISMATCH']);
  assert.ok(c.skills.some(s => s.id === c.health.findings[0].skillId), 'a finding points at a skill in the catalogue');
  assert.equal(c.health.counts.error, 1);
  assert.deepEqual({ entries: c.health.budget.entries, fits: c.health.budget.fits, budget: c.health.budget.budgetChars }, { entries: 3, fits: false, budget: 30 });
  assert.ok(c.health.budget.dropped >= 1);
  assert.deepEqual(c.health.shadows.map(s => `${s.tool}:${s.name}`), ['claude:browser-testing']);

  fs.rmSync(f.source, { recursive: true });
  assert.equal(new ReadService(f.options).refresh().health, null, 'with a source missing the library is unknown, so health is not guessed');
});

test('compare: frontmatter, instructions and shipped files of two copies, side by side', t => {
  const f = fixture(t);
  fs.writeFileSync(path.join(f.vault, 'frontend-design', 'SKILL.md'), '---\nname: frontend-design\ndescription: Vault version\n---\n# Design\nstep one\nstep two\n');
  fs.writeFileSync(path.join(f.source, 'frontend-design', 'SKILL.md'), '---\nname: frontend-design\ndescription: Lab version\nallowed-tools: Bash\n---\n# Design\nstep one\nstep 2\n');
  fs.mkdirSync(path.join(f.source, 'frontend-design', 'scripts'));
  fs.writeFileSync(path.join(f.source, 'frontend-design', 'scripts', 'run.sh'), 'echo hi\n');
  const s = new ReadService(f.options), c = s.refresh();
  const [a, b] = clash(c).candidateIds.map(id => c.skills.find(x => x.id === id)).sort((x, y) => (srcOf(c, x.id) === 'vault' ? -1 : 1)).map(x => x.id);
  const cmp = s.compare(a, b, c.generation);
  assert.equal(cmp.identical, false);
  assert.deepEqual(cmp.fields, [
    { key: 'name', a: 'frontend-design', b: 'frontend-design', same: true },
    { key: 'description', a: 'Vault version', b: 'Lab version', same: false },
    { key: 'allowed-tools', a: null, b: 'Bash', same: false },
  ]);
  assert.deepEqual(cmp.files, [{ path: 'scripts/run.sh', inA: false, inB: true, runs: true, same: false }]);
  assert.deepEqual({ files: cmp.b.fileCount, scripts: cmp.b.scriptCount }, { files: 2, scripts: 1 });
  assert.deepEqual(cmp.body.hunks.filter(h => h.type !== 'same').map(h => `${h.type}:${h.text}`), ['del:step two', 'add:step 2']);
  assert.match(cmp.a.changedAt, /^\d{4}-\d{2}-\d{2}T/);

  assert.throws(() => s.compare(a, a, c.generation), { status: 400 });
  assert.throws(() => s.compare(a, 'f'.repeat(64), c.generation), { status: 404 });
  assert.throws(() => s.compare(a, b, 'old-generation'), { status: 409 });
});

test('a tool that ignores links is told apart from one that follows them; a copy knows if it is stale', t => {
  const f = fixture(t);
  const library = path.join(f.homedir, '.agentforge', 'merged-skills');
  fs.mkdirSync(path.join(f.project, '.agents'), { recursive: true });
  mkLink(library, path.join(f.project, '.agents', 'skills'));
  const report = () => new ReadService(f.options).refresh().projects[0].targets;
  let targets = report();
  assert.equal(targets.find(x => x.id === 'generic').feeds, 'library');
  assert.equal(targets.find(x => x.id === 'antigravity').feeds, 'needs-copy');
  assert.equal(targets.find(x => x.id === 'antigravity').optIn, true);

  const w = new WriteService(f.options);
  const id = new ReadService(f.options).refresh().projects[0].project.id;
  const preview = w.preview({ kind: 'project.wire', args: { projectId: id, targets: ['antigravity'], writeDocs: false } });
  assert.equal(preview.ok, true, preview.conflicts.join(' '));
  assert.ok(preview.lines.some(l => /Unlink \.agents\/skills/.test(l.text)));
  assert.ok(preview.lines.some(l => /Copy the library into \.agents\/skills/.test(l.text)));
  assert.equal(w.apply([{ kind: 'project.wire', args: { projectId: id, targets: ['antigravity'], writeDocs: false } }]).results[0].status, 'applied');
  targets = report();
  assert.deepEqual({ feeds: targets.find(x => x.id === 'antigravity').feeds, copy: targets.find(x => x.id === 'antigravity').copy.state }, { feeds: 'copy', copy: 'fresh' });

  fs.appendFileSync(path.join(f.vault, 'frontend-design', 'SKILL.md'), 'changed in the vault\n');
  assert.equal(report().find(x => x.id === 'antigravity').copy.state, 'stale', 'the library content changed since the copy was made');
});

test('HTTP: the compare route is a read, ID-addressed, and takes only a generation', async t => {
  const f = fixture(t);
  const assetRoot = path.join(f.root, 'ui'); fs.mkdirSync(assetRoot); fs.writeFileSync(path.join(assetRoot, 'index.html'), '<h1>x</h1>');
  const app = await createDashboard({ options: f.options, assetRoot }); t.after(() => app.close());
  const get = route => new Promise((resolve, reject) => {
    const u = new URL(app.url);
    http.get({ hostname: u.hostname, port: u.port, path: route, headers: { 'x-agentforge-read': '1' } }, res => { let b = ''; res.on('data', d => b += d); res.on('end', () => resolve({ status: res.statusCode, body: b })); }).on('error', reject);
  });
  const c = JSON.parse((await get('/api/v1/catalog')).body);
  const [a, b] = clash(c).candidateIds;
  const ok = await get(`/api/v1/skills/${a}/compare/${b}?generation=${c.generation}`);
  assert.equal(ok.status, 200);
  assert.equal(JSON.parse(ok.body).fields[0].key, 'name');
  assert.equal((await get(`/api/v1/skills/${a}/compare/${b}?generation=${c.generation}&path=C:\\x`)).status, 400);
  assert.equal((await get(`/api/v1/skills/${a}/compare/..%2F..%2Fsecret?generation=${c.generation}`)).status, 403);
  assert.equal((await get(`/api/v1/skills/${a}/compare/${b}?generation=stale`)).status, 409);
});

test('"vault" is reserved: a new source cannot take the primary vault\'s name', t => {
  const f = fixture(t);
  const other = makeVault(f.root, 'other', ['x']);
  const paths = createPaths({ homedir: f.homedir, scriptDir: f.root });
  assert.throws(() => addSource({ paths, urlOrPath: other, name: 'vault' }), { exitCode: 2 });
  assert.throws(() => addSource({ paths, urlOrPath: other, name: 'Vault' }), { exitCode: 2 });
});
