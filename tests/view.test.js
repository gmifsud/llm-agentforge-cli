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
  assert.deepEqual(v.collisions, [{ name: 'tdd', kept: 'vault', dropped: 'r1' }, { name: 'ext', kept: 'r1', dropped: 'r2' }]);
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
  assert.deepEqual(v.collisions.find((c) => c.name === 'tdd'), { name: 'tdd', kept: 'r1', dropped: 'vault', preferred: true });
  const forced = computeView({ primaryRoot: vault, repos, cacheRootFor: () => '', forceExternal: true, preferences: { tdd: 'vault' } });
  assert.equal(forced.entries.find((e) => e.name === 'tdd').source, 'vault');
  assert.equal(forced.entries.find((e) => e.name === 'diagnose').source, 'r1');
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
