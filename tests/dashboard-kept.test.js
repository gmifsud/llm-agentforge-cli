'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { WriteService } = require('../dashboard/server/write-service');
const { addSource } = require('../src/application/sources');
const { createPaths } = require('../src/infra/paths');
const { digestSkill } = require('../src/discovery/skill-digest');
const { fixture } = require('./dashboard-fixtures');
const { makeVault } = require('./helpers');

// The fixture: the vault and the "frontend-lab" source both have frontend-design, with different content.
const configPath = f => path.join(f.homedir, '.agentforge', 'config.json');
const readConfig = f => JSON.parse(fs.readFileSync(configPath(f), 'utf8'));
const writeConfig = (f, extra) => fs.writeFileSync(configPath(f), JSON.stringify({ ...readConfig(f), ...extra }));
const KEEP = { skill: 'frontend-design', main: 'vault', keep: [{ source: 'frontend-lab', name: 'frontend-design-lab', description: 'Use when you want the lab variant.' }] };
const keep = (over = {}) => ({ kind: 'library.keep', args: { ...KEEP, ...over } });
const apply = (svc, ...changes) => svc.apply(changes).results;
const digestOf = dir => digestSkill(dir).digest;
const hasLine = (p, re) => p.lines.some(l => re.test(l.text));
const attach = (f, folder, name) => addSource({ paths: createPaths({ homedir: f.homedir, scriptDir: path.resolve(__dirname, '..') }), urlOrPath: folder, name });

test('library.keep previews, then saves the main choice pinned to the digests and one rule', t => {
  const f = fixture(t);
  const svc = new WriteService(f.options);
  const p = svc.preview(keep());
  assert.equal(p.ok, true, JSON.stringify(p.conflicts));
  assert.ok(hasLine(p, /keeps the name `frontend-design`/));
  assert.ok(hasLine(p, /is kept as `frontend-design-lab`/));

  const [r] = apply(svc, { kind: 'library.keep', args: p.args });
  assert.equal(r.status, 'applied', r.message);
  const saved = readConfig(f);
  const pref = saved.preferences['frontend-design'];
  assert.equal(pref.source, 'vault');
  assert.deepEqual(pref.digests, { vault: digestOf(path.join(f.vault, 'frontend-design')), 'frontend-lab': digestOf(path.join(f.source, 'frontend-design')) });
  assert.equal(saved.kept.length, 1);
  assert.deepEqual(saved.kept[0].from, { skill: 'frontend-design', source: 'frontend-lab' });
  assert.equal(saved.kept[0].name, 'frontend-design-lab');
  assert.equal(saved.kept[0].digest, digestOf(path.join(f.source, 'frontend-design')));
});

test('library.keep refuses each wrong input with a conflict naming the cause', t => {
  const f = fixture(t);
  const svc = new WriteService(f.options);
  const refusedWith = (change, re) => { const p = svc.preview(change); assert.equal(p.ok, false); assert.match(p.conflicts.join(' '), re); };
  refusedWith(keep({ keep: [] }), /frontend-lab/);
  refusedWith(keep({ keep: [{ ...KEEP.keep[0], name: 'sql-review' }] }), /must start with "frontend-design-"/);
  refusedWith(keep({ keep: [{ ...KEEP.keep[0], name: 'sql-review-lab' }] }), /must start with "frontend-design-"/);
  refusedWith(keep({ keep: [{ ...KEEP.keep[0], description: '  ' }] }), /description.*must not be empty/);
  refusedWith(keep({ main: 'nowhere' }), /"nowhere" does not provide/);
  refusedWith(keep({ keep: [...KEEP.keep, { source: 'vault', name: 'frontend-design-vault', description: 'x' }] }), /vault/);
  assert.equal(readConfig(f).kept, undefined, 'nothing saved');
});

test('library.keep refuses a name that another rule or another entry already holds', t => {
  const f = fixture(t);
  const svc = new WriteService(f.options);
  apply(svc, keep());
  const other = makeVault(f.root, 'other', ['frontend-design', 'sql-review']);
  attach(f, other, 'other');
  // Another clash cannot reuse a name held by a rule of this one.
  const same = svc.preview({ kind: 'library.keep', args: { skill: 'frontend-design', main: 'frontend-lab', keep: [
    { source: 'vault', name: 'frontend-design-lab', description: 'd' }, { source: 'other', name: 'frontend-design-lab', description: 'd' }] } });
  assert.equal(same.ok, false);
  assert.match(same.conflicts.join(' '), /already in use/);
  const ok = svc.preview({ kind: 'library.keep', args: { skill: 'sql-review', main: 'vault', keep: [{ source: 'other', name: 'sql-review-x', description: 'd' }] } });
  assert.equal(ok.ok, true, JSON.stringify(ok.conflicts));
});

test('library.keep names the source to use when a copy is identical to a higher-ranked one', t => {
  const f = fixture(t);
  const twin = makeVault(f.root, 'twin', []);
  fs.cpSync(path.join(f.source, 'frontend-design'), path.join(twin, 'frontend-design'), { recursive: true });
  attach(f, twin, 'twin');
  const svc = new WriteService(f.options);
  const wrong = svc.preview(keep({ keep: [{ source: 'twin', name: 'frontend-design-lab', description: 'd' }] }));
  assert.equal(wrong.ok, false);
  assert.match(wrong.conflicts.join(' '), /use frontend-lab/i);
  const right = svc.preview(keep());
  assert.equal(right.ok, true, JSON.stringify(right.conflicts));
  assert.ok(hasLine(right, /twin.*same.*kept once as `frontend-design-lab`/i));
});

test('library.keep refuses at apply time when a copy changed since the preview', t => {
  const f = fixture(t);
  const svc = new WriteService(f.options);
  const p = svc.preview(keep());
  fs.appendFileSync(path.join(f.source, 'frontend-design', 'SKILL.md'), '\nMore.\n');
  const [r] = apply(svc, { kind: 'library.keep', args: p.args });
  assert.equal(r.status, 'refused');
  assert.match(r.message, /changed since you looked/);
  assert.equal(readConfig(f).kept, undefined);
});

test('choosing a different main re-saves the clash: old main gets a rule, the new main loses its rule', t => {
  const f = fixture(t);
  const svc = new WriteService(f.options);
  apply(svc, keep());
  const flipped = { skill: 'frontend-design', main: 'frontend-lab', keep: [{ source: 'vault', name: 'frontend-design-vault', description: 'The vault variant.' }] };
  const pv = svc.preview({ kind: 'library.keep', args: flipped });
  assert.ok(pv.lines.some(l => l.tone === 'remove' && /frontend-design-lab/.test(l.text)), 'the rule that goes away is named');
  const [r] = apply(svc, { kind: 'library.keep', args: flipped });
  assert.equal(r.status, 'applied', r.message);
  const saved = readConfig(f);
  assert.deepEqual(saved.kept.map(k => [k.name, k.from.source]), [['frontend-design-vault', 'vault']]);
  assert.equal(saved.preferences['frontend-design'].source, 'frontend-lab');
});

test('library.unkeep previews what agents lose and removes only that rule', t => {
  const f = fixture(t);
  attach(f, makeVault(f.root, 'other', ['frontend-design']), 'other');
  const svc = new WriteService(f.options);
  apply(svc, { kind: 'library.keep', args: { skill: 'frontend-design', main: 'vault', keep: [
    { source: 'frontend-lab', name: 'frontend-design-lab', description: 'a' }, { source: 'other', name: 'frontend-design-other', description: 'b' }] } });
  assert.equal(readConfig(f).kept.length, 2);
  const p = svc.preview({ kind: 'library.unkeep', args: { name: 'frontend-design-lab' } });
  assert.equal(p.ok, true);
  assert.ok(p.lines.some(l => l.tone === 'remove' && /agents lose that copy after the rebuild/i.test(l.text)));
  const [r] = apply(svc, { kind: 'library.unkeep', args: { name: 'frontend-design-lab' } });
  assert.equal(r.status, 'applied', r.message);
  assert.deepEqual(readConfig(f).kept.map(k => k.name), ['frontend-design-other']);
  assert.equal(svc.preview({ kind: 'library.unkeep', args: { name: 'nope' } }).ok, false);
});

test('library.prefer lists each kept copy as a remove line and apply removes them', t => {
  const f = fixture(t);
  const svc = new WriteService(f.options);
  apply(svc, keep());
  const p = svc.preview({ kind: 'library.prefer', args: { skill: 'frontend-design', source: 'vault' } });
  assert.equal(p.ok, true);
  assert.ok(p.lines.some(l => l.tone === 'remove' && /frontend-design-lab/.test(l.text)));
  const [r] = apply(svc, { kind: 'library.prefer', args: { skill: 'frontend-design', source: 'vault' } });
  assert.equal(r.status, 'applied', r.message);
  const saved = readConfig(f);
  assert.equal(saved.kept, undefined);
  assert.equal(saved.preferences['frontend-design'].source, 'vault');
});

test('a preference written between preview and apply is not lost', t => {
  const f = fixture(t);
  const svc = new WriteService(f.options);
  const p = svc.preview(keep());
  writeConfig(f, { preferences: { 'sql-review': { source: 'vault', digests: {}, chosenAt: 'then' } } });
  const [r] = apply(svc, { kind: 'library.keep', args: p.args });
  assert.equal(r.status, 'applied', r.message);
  const saved = readConfig(f);
  assert.equal(saved.preferences['sql-review'].chosenAt, 'then');
  assert.equal(saved.preferences['frontend-design'].source, 'vault');
});

test('re-saving a source under a new name names the old copy as leaving and keeps only the new rule', t => {
  const f = fixture(t);
  const svc = new WriteService(f.options);
  apply(svc, keep());
  const renamed = keep({ keep: [{ ...KEEP.keep[0], name: 'frontend-design-lab2' }] });
  const p = svc.preview(renamed);
  assert.equal(p.ok, true, JSON.stringify(p.conflicts));
  assert.ok(p.lines.some(l => l.tone === 'remove' && /frontend-design-lab\b(?!2)/.test(l.text)));
  assert.ok(!p.lines.some(l => /Agents will see/.test(l.text)), 'net zero: no count line');
  const [r] = apply(svc, { kind: 'library.keep', args: p.args });
  assert.equal(r.status, 'applied', r.message);
  assert.deepEqual(readConfig(f).kept.map(k => k.name), ['frontend-design-lab2']);
});
