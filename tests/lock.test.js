'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createPaths } = require('../src/infra/paths');
const { readLock, writeLock, snapshot, diffLock, lockFile, revisionLookup } = require('../src/application/lock');
const { syncView } = require('../src/application/sync');
const { fixture } = require('./dashboard-fixtures');
const { tempRoot, makeVault } = require('./helpers');

const entry = (root, source, name) => ({ name, source, absolutePath: path.join(root, name) });

test('a snapshot records source, revision and a content digest per skill, in name order', (t) => {
  const root = makeVault(tempRoot(t), 'src', ['zeta', 'alpha']);
  const snap = snapshot([entry(root, 'one', 'zeta'), entry(root, 'one', 'alpha')], (s) => (s === 'one' ? 'abc1234' : null));
  assert.deepEqual(Object.keys(snap), ['alpha', 'zeta']);
  assert.equal(snap.alpha.source, 'one');
  assert.equal(snap.alpha.revision, 'abc1234');
  assert.match(snap.alpha.digest, /^[a-f0-9]{64}$/);
  assert.notEqual(snap.alpha.digest, snap.zeta.digest, 'different content, different digest');
  assert.equal(JSON.stringify(snap), JSON.stringify(snapshot([entry(root, 'one', 'alpha'), entry(root, 'one', 'zeta')], (s) => (s === 'one' ? 'abc1234' : null))), 'the same on every run');
});

test('a skill that cannot be read is recorded with no digest instead of failing the build', (t) => {
  const snap = snapshot([{ name: 'gone', source: 'vault', absolutePath: path.join(tempRoot(t), 'nope') }]);
  assert.deepEqual(snap.gone, { source: 'vault', revision: null, digest: null });
});

test('the lock is only ever compared with: missing, corrupt or foreign files count as no record', (t) => {
  const paths = createPaths({ homedir: tempRoot(t), scriptDir: path.resolve(__dirname, '..') });
  assert.equal(readLock(paths), null, 'none yet');
  fs.mkdirSync(paths.agentforgeDir, { recursive: true });
  fs.writeFileSync(lockFile(paths), '{ not json');
  assert.equal(readLock(paths), null, 'corrupt');
  fs.writeFileSync(lockFile(paths), JSON.stringify({ version: 99, skills: {} }));
  assert.equal(readLock(paths), null, 'from another version');
  fs.writeFileSync(lockFile(paths), JSON.stringify({ version: 1, skills: 'x' }));
  assert.equal(readLock(paths), null, 'wrong shape');
  writeLock(paths, { a: { source: 'vault', revision: null, digest: 'd' } });
  const lock = readLock(paths);
  assert.deepEqual(lock.skills, { a: { source: 'vault', revision: null, digest: 'd' } });
  assert.match(lock.builtAt, /^\d{4}-\d\d-\d\dT/);
});

test('what changed since the last build: added, removed, content changed, moved to another source', () => {
  const was = { version: 1, builtAt: 'x', skills: {
    keep: { source: 'vault', revision: null, digest: 'k' },
    edit: { source: 'one', revision: 'r1', digest: 'e1' },
    gone: { source: 'one', revision: 'r1', digest: 'g' },
    move: { source: 'one', revision: 'r1', digest: 'm' },
  } };
  const now = {
    keep: { source: 'vault', revision: null, digest: 'k' },
    edit: { source: 'one', revision: 'r2', digest: 'e2' },
    move: { source: 'two', revision: 'r9', digest: 'm' },
    fresh: { source: 'two', revision: 'r9', digest: 'f' },
  };
  assert.deepEqual(diffLock(was, now), { first: false, added: ['fresh'], removed: ['gone'], changed: ['edit'], moved: ['move'] });
  assert.deepEqual(diffLock(was, was.skills), { first: false, added: [], removed: [], changed: [], moved: [] }, 'nothing changed');
  assert.deepEqual(diffLock(null, now), { first: true, added: [], removed: [], changed: [], moved: [] }, 'no earlier build to compare with');
});

test('a skill whose content could not be read is only called changed when its source moved on', () => {
  const was = { version: 1, builtAt: 'x', skills: { a: { source: 'one', revision: 'r1', digest: null }, b: { source: 'one', revision: 'r1', digest: null } } };
  const now = { a: { source: 'one', revision: 'r1', digest: 'd' }, b: { source: 'one', revision: 'r2', digest: null } };
  assert.deepEqual(diffLock(was, now).changed, ['b']);
});

test('revisions come from Git for Git sources only', () => {
  const git = { revision: (dir) => `rev-of-${path.basename(dir)}` };
  const repos = [{ name: 'team', type: 'git' }, { name: 'folder', type: 'local' }];
  const lookup = revisionLookup({ repos, git, rootFor: (r) => path.join('cache', r.name) });
  assert.equal(lookup('team'), 'rev-of-team');
  assert.equal(lookup('folder'), null);
  assert.equal(lookup('vault'), null);
  assert.equal(lookup('unknown'), null);
  assert.equal(revisionLookup({ repos, git: { revision() { throw new Error('no git'); } }, rootFor: () => 'x' })('team'), null, 'a failing Git client is not a failed build');
});

test('every build records the library, and the next one says what changed in the sources since', (t) => {
  const f = fixture(t);
  const paths = createPaths({ homedir: f.homedir, scriptDir: path.resolve(__dirname, '..') });
  const build = (extra = {}) => syncView({ paths, env: {}, fetch: false, git: {}, ...extra });

  const first = build();
  assert.equal(first.lock.changes.first, true, 'no record before the first build');
  const recorded = readLock(paths);
  assert.deepEqual(Object.keys(recorded.skills).sort(), ['browser-testing', 'frontend-design', 'sql-review']);
  assert.equal(recorded.skills['sql-review'].source, 'vault');

  assert.deepEqual(build().lock.changes, { first: false, added: [], removed: [], changed: [], moved: [] }, 'a second build of the same sources changes nothing');

  // A source's file changes without any link changing: only the record can say so.
  fs.appendFileSync(path.join(f.vault, 'sql-review', 'SKILL.md'), 'edited\n');
  makeVault(f.root, 'extra', ['perf']);
  fs.writeFileSync(f.registry, JSON.stringify({ repositories: [...f.repos, { name: 'extra', type: 'local', url_or_path: path.join(f.root, 'extra') }] }));
  const dry = build({ dryRun: true });
  assert.deepEqual([dry.lock.changes.changed, dry.lock.changes.added], [['sql-review'], ['perf']]);
  assert.equal(readLock(paths).skills['sql-review'].digest, recorded.skills['sql-review'].digest, 'a dry run reports the change but does not record it');

  const real = build();
  assert.deepEqual([real.lock.changes.changed, real.lock.changes.added], [['sql-review'], ['perf']]);
  assert.notEqual(readLock(paths).skills['sql-review'].digest, recorded.skills['sql-review'].digest, 'the build records what it built');
  assert.deepEqual(build().lock.changes.changed, [], 'and the change is reported once');

  // The library is built from the sources on disk, whatever the record says.
  fs.writeFileSync(lockFile(paths), '{ not json');
  const afterCorrupt = build();
  assert.equal(afterCorrupt.lock.changes.first, true);
  assert.equal(afterCorrupt.linked, 4, 'a damaged record changes nothing about what is built');
});

test('update and repo sync say what changed in the sources since the last build', (t) => {
  const { run } = require('../src/cli/main');
  const f = fixture(t);
  const go = (argv) => {
    let out = '', err = '';
    const code = run(argv, { homedir: f.homedir, env: {}, stdout: { write: (s) => { out += s; }, isTTY: false }, stderr: { write: (s) => { err += s; }, isTTY: false }, cwd: f.root });
    return { code, out, err };
  };
  const first = go(['update', '--no-fetch']);
  assert.equal(first.code, 0, first.err);
  assert.match(first.out, /no earlier build on record/);
  assert.match(go(['repo', 'sync', '--no-fetch']).out, /no skill changed since the last build/);

  fs.appendFileSync(path.join(f.vault, 'sql-review', 'SKILL.md'), 'edited\n');
  const dry = go(['update', '--no-fetch', '--dry-run']);
  assert.match(dry.out, /content changed: 1  \(sql-review\)/);
  const real = go(['update', '--no-fetch']);
  assert.match(real.out, /since the last build:/);
  assert.match(real.out, /content changed: 1  \(sql-review\)/);
  assert.match(go(['update', '--no-fetch']).out, /no skill changed since the last build/, 'reported once');
});
