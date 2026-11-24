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

test('materializeView replaces a staged view and leaves link targets untouched', (t) => {
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

for (const relative of ['merged-skills', path.join('views', 'focus')]) {
  test(`materializeView restores ${relative} after promotion failure, then permits a retry`, t => {
    const root = tempRoot(t);
    const v1 = makeVault(root, 'v1', ['a']);
    const v2 = makeVault(root, 'v2', ['b']);
    const view = path.join(root, relative);
    const original = [{ name: 'a', absolutePath: path.join(v1, 'a') }];
    const next = [{ name: 'b', absolutePath: path.join(v2, 'b') }];
    materializeView(view, original);
    const before = fs.readFileSync(path.join(view, 'a', 'SKILL.md'), 'utf8');
    const rename = fs.renameSync;
    let failPromotion = true;
    t.mock.method(fs, 'renameSync', (from, to) => {
      if (from === `${view}.staging-${process.pid}` && to === view && failPromotion) {
        failPromotion = false;
        throw Object.assign(new Error('promotion denied'), { code: 'EACCES' });
      }
      return rename(from, to);
    });

    assert.throws(() => materializeView(view, next), /promotion denied/);
    assert.deepEqual(fs.readdirSync(view), ['a']);
    assert.equal(fs.readFileSync(path.join(view, 'a', 'SKILL.md'), 'utf8'), before);
    assert.equal(fs.existsSync(`${view}.old-${process.pid}`), false);
    assert.equal(fs.existsSync(`${view}.staging-${process.pid}`), false);

    assert.equal(materializeView(view, next).linked, 1);
    assert.deepEqual(fs.readdirSync(view), ['b']);
    assert.equal(fs.readFileSync(path.join(v1, 'a', 'SKILL.md'), 'utf8'), before);
    assert.ok(fs.existsSync(path.join(v2, 'b', 'SKILL.md')));
  });
}

test('materializeView preserves recovery paths and reports both failures when rollback also fails', t => {
  const root = tempRoot(t);
  const vault = makeVault(root, 'vault', ['a', 'b']);
  const view = path.join(root, 'merged-skills');
  materializeView(view, [{ name: 'a', absolutePath: path.join(vault, 'a') }]);
  const old = `${view}.old-${process.pid}`, staging = `${view}.staging-${process.pid}`;
  const rename = fs.renameSync;
  t.mock.method(fs, 'renameSync', (from, to) => {
    if (to === view && [old, staging].includes(from)) throw new Error(from === old ? 'restore denied' : 'promotion denied');
    return rename(from, to);
  });
  assert.throws(() => materializeView(view, [{ name: 'b', absolutePath: path.join(vault, 'b') }]), e => {
    assert.equal(e.code, 'VIEW_RECOVERY_FAILED');
    for (const text of ['promotion denied', 'restore denied', old, staging]) assert.ok(e.message.includes(text), e.message);
    return true;
  });
  assert.ok(fs.existsSync(path.join(old, 'a', 'SKILL.md')));
  assert.ok(fs.existsSync(path.join(staging, 'b', 'SKILL.md')));
  assert.throws(() => materializeView(view, []), { code: 'VIEW_BACKUP' });
  assert.ok(fs.existsSync(path.join(old, 'a', 'SKILL.md')));
  assert.ok(fs.existsSync(path.join(staging, 'b', 'SKILL.md')));
});

test('materializeView refuses an existing backup without changing it or the live view', t => {
  const root = tempRoot(t);
  const vault = makeVault(root, 'vault', ['a']);
  const view = path.join(root, 'merged-skills');
  const entries = [{ name: 'a', absolutePath: path.join(vault, 'a') }];
  materializeView(view, entries);
  const backup = `${view}.old-${process.pid}`;
  fs.mkdirSync(backup);
  fs.writeFileSync(path.join(backup, 'keep.txt'), 'recovery data');
  assert.throws(() => materializeView(view, entries), { code: 'VIEW_BACKUP' });
  assert.equal(fs.readFileSync(path.join(backup, 'keep.txt'), 'utf8'), 'recovery data');
  assert.ok(fs.existsSync(path.join(view, 'a', 'SKILL.md')));
  assert.equal(fs.existsSync(`${view}.staging-${process.pid}`), false);
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

// A vault and a source both ship `brainstorming` (different content); the vault is pinned, so r1's copy is a candidate for keeping.
function keptFixture(t, { r1Skill = 'brainstorming', r1Extra = [], pinned = 'vault', rule = {} } = {}) {
  const { digestSkill } = require('../src/discovery/skill-digest');
  const root = tempRoot(t);
  const vault = makeVault(root, 'vault', ['brainstorming']);
  const r1 = makeVault(root, 'r1', [r1Skill, ...r1Extra]);
  const repos = [{ name: 'r1', type: 'local', url_or_path: r1 }];
  const keptDir = path.join(root, 'kept');
  const original = path.join(r1, r1Skill);
  const kept = [{ name: 'brainstorming-r1', from: { skill: 'brainstorming', source: 'r1' }, description: 'kept copy', digest: digestSkill(original).digest, keptAt: 'now', ...rule }];
  const args = { primaryRoot: vault, repos, cacheRootFor: () => '', preferences: { brainstorming: pinned }, kept, keptDir };
  return { root, vault, r1, original, keptDir, args };
}

test('kept rules become library entries beside the winner', (t) => {
  const f = keptFixture(t);
  const v = computeView(f.args);
  assert.deepEqual(v.entries.map((e) => e.name), ['brainstorming', 'brainstorming-r1']);
  const e = v.entries[1];
  assert.equal(e.source, 'r1');
  assert.equal(e.absolutePath, path.join(f.keptDir, 'brainstorming-r1'));
  assert.deepEqual(e.kept, { from: { skill: 'brainstorming', source: 'r1' }, stale: false });
  assert.deepEqual(v.kept, [{ name: 'brainstorming-r1', from: { skill: 'brainstorming', source: 'r1' }, description: 'kept copy', stale: false, absolutePath: path.join(f.keptDir, 'brainstorming-r1'), originalPath: f.original }]);
  assert.deepEqual(v.keptMissing, []);
  assert.deepEqual(v.keptBlocked, []);
});

test('a kept rule is stale once its original changes', (t) => {
  const f = keptFixture(t);
  fs.appendFileSync(path.join(f.original, 'SKILL.md'), 'edited upstream\n');
  const v = computeView(f.args);
  assert.equal(v.kept[0].stale, true);
  assert.equal(v.entries[1].kept.stale, true);
});

test('a kept rule whose original has gone is reported missing, makes no entry, and does not throw', (t) => {
  const f = keptFixture(t);
  fs.rmSync(f.original, { recursive: true });
  const v = computeView(f.args);
  assert.deepEqual(v.keptMissing, [{ name: 'brainstorming-r1', from: { skill: 'brainstorming', source: 'r1' } }]);
  assert.deepEqual(v.entries.map((e) => e.name), ['brainstorming']);
  assert.deepEqual(v.kept, []);
});

test('a kept rule whose name a source skill already holds is blocked as taken', (t) => {
  const f = keptFixture(t, { r1Extra: ['brainstorming-r1'] });
  const v = computeView(f.args);
  assert.deepEqual(v.keptBlocked, [{ name: 'brainstorming-r1', from: { skill: 'brainstorming', source: 'r1' }, reason: 'taken' }]);
  assert.equal(v.entries.find((e) => e.name === 'brainstorming-r1').source, 'r1');
  assert.equal(v.entries.find((e) => e.name === 'brainstorming-r1').kept, undefined);
  assert.deepEqual(v.kept, []);
});

test('two rules with one name: the first is accepted, the second is blocked as taken', (t) => {
  const f = keptFixture(t);
  f.args.kept = [f.args.kept[0], { ...f.args.kept[0] }];
  const v = computeView(f.args);
  assert.equal(v.kept.length, 1);
  assert.equal(v.keptBlocked[0].reason, 'taken');
});

test('a kept rule whose original is the winner is blocked as is-main', (t) => {
  const f = keptFixture(t, { pinned: 'r1' });
  const v = computeView(f.args);
  assert.deepEqual(v.keptBlocked, [{ name: 'brainstorming-r1', from: { skill: 'brainstorming', source: 'r1' }, reason: 'is-main' }]);
  assert.deepEqual(v.entries.map((e) => e.name), ['brainstorming']);
});

test('a kept rule whose original is now the only copy is blocked as is-main', (t) => {
  const f = keptFixture(t);
  fs.rmSync(path.join(f.vault, 'brainstorming'), { recursive: true });
  const v = computeView(f.args);
  assert.equal(v.keptBlocked[0].reason, 'is-main');
});

test('without a keptDir, kept rows are computed but no entries are added', (t) => {
  const f = keptFixture(t);
  const v = computeView({ ...f.args, keptDir: null });
  assert.equal(v.kept[0].absolutePath, null);
  assert.deepEqual(v.entries.map((e) => e.name), ['brainstorming']);
});

test('a kept rule matches its original case-insensitively on Windows', (t) => {
  if (process.platform !== 'win32') return t.skip('name matching is case-sensitive off Windows');
  const f = keptFixture(t, { r1Skill: 'Brainstorming' });   // the rule says "brainstorming"; the source spells it "Brainstorming"
  const v = computeView(f.args);
  assert.equal(v.kept.length, 1);
  assert.equal(v.kept[0].stale, false);
  assert.deepEqual(v.keptMissing, []);
});
