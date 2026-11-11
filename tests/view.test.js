'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { computeView, materializeView } = require('../src/deployment/build-view');
const { inspectDestination } = require('../src/infra/fs-inspect');
const { tempRoot, makeVault, mkLink } = require('./helpers');

test('computeView: vault wins collisions unless forced; external-external first wins', (t) => {
  const root = tempRoot(t);
  const vault = makeVault(root, 'vault', ['tdd', 'own']);
  const r1 = makeVault(root, 'r1', ['tdd', 'ext']);
  const r2 = makeVault(root, 'r2', ['ext', 'other']);
  const repos = [{ name: 'r1', type: 'local', url_or_path: r1 }, { name: 'r2', type: 'local', url_or_path: r2 }];
  const v = computeView({ primaryRoot: vault, repos, cacheRootFor: () => '' });
  assert.deepEqual(v.entries.map((e) => `${e.name}@${e.source}`).sort(), ['ext@r1', 'other@r2', 'own@vault', 'tdd@vault']);
  assert.deepEqual(v.collisions, [{ name: 'tdd', kept: 'vault', dropped: 'r1', by: 'default' }, { name: 'ext', kept: 'r1', dropped: 'r2', by: 'default' }]);
  const f = computeView({ primaryRoot: vault, repos, cacheRootFor: () => '', forceExternal: true });
  assert.ok(f.entries.some((e) => e.name === 'tdd' && e.source === 'r1'));
});

test('computeView: a per-skill preference beats the default rule and --force, and stale preferences are ignored', (t) => {
  const root = tempRoot(t);
  const vault = makeVault(root, 'vault', ['tdd', 'diagnose']);
  const r1 = makeVault(root, 'r1', ['tdd', 'diagnose']);
  const repos = [{ name: 'r1', type: 'local', url_or_path: r1 }];
  const v = computeView({ primaryRoot: vault, repos, cacheRootFor: () => '', preferences: { tdd: 'r1', diagnose: 'nobody' } });
  const by = Object.fromEntries(v.entries.map((e) => [e.name, e.source]));
  assert.deepEqual(by, { tdd: 'r1', diagnose: 'vault' });
  assert.deepEqual(v.collisions.find((c) => c.name === 'tdd'), { name: 'tdd', kept: 'r1', dropped: 'vault', by: 'choice', preferred: true });
  const forced = computeView({ primaryRoot: vault, repos, cacheRootFor: () => '', forceExternal: true, preferences: { tdd: 'vault' } });
  assert.equal(forced.entries.find((e) => e.name === 'tdd').source, 'vault');
  assert.equal(forced.entries.find((e) => e.name === 'diagnose').source, 'r1');
});

test('identical copies are not a clash; a real difference is', (t) => {
  const root = tempRoot(t);
  const vault = makeVault(root, 'vault', ['same', 'differs']);
  const fork = path.join(root, 'fork');
  fs.cpSync(vault, fork, { recursive: true });                                   // byte-identical copy of both
  fs.appendFileSync(path.join(fork, 'differs', 'SKILL.md'), 'one more line\n');   // now one really differs
  fs.writeFileSync(path.join(fork, 'same', 'SKILL.md'), fs.readFileSync(path.join(vault, 'same', 'SKILL.md'), 'utf8').replace(/\n/g, '\r\n')); // CRLF only
  const v = computeView({ primaryRoot: vault, repos: [{ name: 'fork', type: 'local', url_or_path: fork }], cacheRootFor: () => '' });
  assert.deepEqual(v.identical, [{ name: 'same', kept: 'vault', dropped: 'fork' }]);
  assert.deepEqual(v.collisions, [{ name: 'differs', kept: 'vault', dropped: 'fork', by: 'default' }]);
  assert.equal(v.entries.length, 2);
  assert.equal(v.clashes.find((c) => c.name === 'same').candidates.find((c) => c.source === 'fork').identical, true);
});

test('source order decides clashes; a per-skill choice still beats it; unknown names are ignored', (t) => {
  const root = tempRoot(t);
  const vault = makeVault(root, 'vault', ['a', 'b']);
  const r1 = makeVault(root, 'r1', ['a', 'b', 'c']);
  const r2 = makeVault(root, 'r2', ['a', 'c']);
  const repos = [{ name: 'r1', type: 'local', url_or_path: r1 }, { name: 'r2', type: 'local', url_or_path: r2 }];
  const by = (v) => Object.fromEntries(v.entries.map((e) => [e.name, e.source]));
  const base = { primaryRoot: vault, repos, cacheRootFor: () => '' };
  assert.deepEqual(by(computeView(base)), { a: 'vault', b: 'vault', c: 'r1' });
  const ordered = computeView({ ...base, sourcePriority: ['r2', 'nobody', 'r1', 'vault'] });
  assert.deepEqual(by(ordered), { a: 'r2', b: 'r1', c: 'r2' });
  assert.ok(ordered.collisions.every((c) => c.by === 'order'));
  // Sources left out of the list keep their default place after the listed ones.
  const partial = computeView({ ...base, sourcePriority: ['r2'] });
  assert.deepEqual(by(partial), { a: 'r2', b: 'vault', c: 'r2' });
  assert.equal(partial.collisions.find((c) => c.name === 'b').by, 'default', 'b was not settled by the explicit list');
  assert.deepEqual(by(computeView({ ...base, sourcePriority: ['r2', 'r1', 'vault'], preferences: { a: 'vault' } })), { a: 'vault', b: 'r1', c: 'r2' });
});

test('a pinned choice holds but is flagged when a candidate changes or a new one appears', (t) => {
  const root = tempRoot(t);
  const vault = makeVault(root, 'vault', ['tdd']);
  const r1 = makeVault(root, 'r1', ['tdd']);
  const repos = [{ name: 'r1', type: 'local', url_or_path: r1 }];
  const base = { primaryRoot: vault, repos, cacheRootFor: () => '' };
  const now = Object.fromEntries(computeView(base).clashes[0].candidates.map((c) => [c.source, c.digest]));
  const pinned = { tdd: { source: 'r1', digests: now } };
  const fresh = computeView({ ...base, preferences: pinned });
  assert.deepEqual(fresh.collisions, [{ name: 'tdd', kept: 'r1', dropped: 'vault', by: 'choice', preferred: true }]);
  assert.equal(fresh.clashes[0].stale, false);

  fs.appendFileSync(path.join(vault, 'tdd', 'SKILL.md'), 'vault edited after the choice\n');
  const stale = computeView({ ...base, preferences: pinned });
  assert.equal(stale.entries[0].source, 'r1', 'the choice is not silently reversed');
  assert.deepEqual(stale.clashes[0].changed, ['vault']);
  assert.equal(stale.collisions[0].stale, true);

  const r2 = makeVault(root, 'r2', ['tdd']);
  const withNew = computeView({ ...base, repos: [...repos, { name: 'r2', type: 'local', url_or_path: r2 }], preferences: { tdd: { source: 'r1', digests: now } } });
  assert.ok(withNew.clashes[0].changed.includes('r2'), 'a candidate that did not exist when you chose counts as a change');
});

test('materializeView swaps atomically and leaves link targets untouched', (t) => {
  const root = tempRoot(t);
  const v1 = makeVault(root, 'v1', ['a', 'b']);
  const v2 = makeVault(root, 'v2', ['b', 'c']);
  const view = path.join(root, 'home', '.agentforge', 'merged-skills');

  materializeView(view, [{ name: 'a', absolutePath: path.join(v1, 'a') }, { name: 'b', absolutePath: path.join(v1, 'b') }]);
  assert.deepEqual(fs.readdirSync(view).sort(), ['a', 'b']);

  materializeView(view, [{ name: 'b', absolutePath: path.join(v2, 'b') }, { name: 'c', absolutePath: path.join(v2, 'c') }]);
  assert.deepEqual(fs.readdirSync(view).sort(), ['b', 'c']);
  assert.ok(fs.existsSync(path.join(v1, 'a', 'SKILL.md')), 'old target intact');
  assert.ok(fs.existsSync(path.join(v1, 'b', 'SKILL.md')), 'old target intact');
  assert.equal(inspectDestination(path.join(view, 'b')).kind, 'link');
  assert.ok(!fs.existsSync(`${view}.old-${process.pid}`) && !fs.existsSync(`${view}.staging-${process.pid}`), 'no temp dirs left');
});

test('materializeView refuses a view containing a non-link entry (user data in the way)', (t) => {
  const root = tempRoot(t);
  const v1 = makeVault(root, 'v1', ['a']);
  const view = path.join(root, 'merged-skills');
  fs.mkdirSync(path.join(view, 'real-dir'), { recursive: true });
  fs.writeFileSync(path.join(view, 'real-dir', 'keep.txt'), 'x');
  mkLink(path.join(v1, 'a'), path.join(view, 'a'));
  assert.throws(() => materializeView(view, [{ name: 'a', absolutePath: path.join(v1, 'a') }]), { code: 'VIEW_SHAPE' });
  assert.ok(fs.existsSync(path.join(view, 'real-dir', 'keep.txt')));
});
