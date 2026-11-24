'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createPaths, loadRegistry, resolveDeployRoot, resolvePrimarySource } = require('../src/infra/paths');
const { createGit } = require('../src/infra/git');
const { addSource, removeSource, fetchSources, CACHE_MARKER } = require('../src/application/sources');
const { tempRoot, makeVault } = require('./helpers');

function fakeHome(t) {
  const root = tempRoot(t);
  const home = path.join(root, 'home');
  fs.mkdirSync(home);
  return { root, home, paths: createPaths({ homedir: home, scriptDir: root }) };
}

test('corrupt repos.json fails closed and is never overwritten', (t) => {
  const { paths } = fakeHome(t);
  fs.mkdirSync(paths.agentforgeDir);
  fs.writeFileSync(paths.reposJson, '{ not json');
  assert.throws(() => loadRegistry(paths), { code: 'CONFIG_CORRUPT' });
  assert.throws(() => addSource({ paths, urlOrPath: 'https://x/y.git' }), { code: 'CONFIG_CORRUPT' });
  assert.equal(fs.readFileSync(paths.reposJson, 'utf8'), '{ not json');
});

test('add: validates id, scheme, local path; no branch recorded unless given', (t) => {
  const { root, paths } = fakeHome(t);
  const local = makeVault(root, 'local-src', ['s']);
  const a = addSource({ paths, urlOrPath: local });
  assert.deepEqual(a, { name: 'local-src', url_or_path: local, type: 'local' });
  const g = addSource({ paths, urlOrPath: 'https://github.com/x/y.git' });
  assert.deepEqual(g, { name: 'y', url_or_path: 'https://github.com/x/y.git', type: 'git' });
  assert.throws(() => addSource({ paths, urlOrPath: 'https://github.com/x/z.git', name: '../escape' }), { exitCode: 2 });
  assert.throws(() => addSource({ paths, urlOrPath: path.join(root, 'nope') }), { exitCode: 2 });
  assert.throws(() => addSource({ paths, urlOrPath: 'https://github.com/x/y.git' }), { code: 'DUPLICATE_SOURCE' });
  assert.throws(() => addSource({ paths, urlOrPath: 'https://github.com/x/w.git', branch: '--upload-pack=x' }), { exitCode: 2 });
});

test('remove: never deletes a registered local path; only deletes a marked, contained cache dir', (t) => {
  const { root, paths } = fakeHome(t);
  const local = makeVault(root, 'local-src', ['s']);
  addSource({ paths, urlOrPath: local });
  removeSource({ paths, name: 'local-src' });
  assert.ok(fs.existsSync(path.join(local, 's', 'SKILL.md')), 'local source untouched');

  addSource({ paths, urlOrPath: 'https://github.com/x/y.git' });
  const cache = path.join(paths.reposCache, 'y');
  fs.mkdirSync(cache, { recursive: true });
  fs.writeFileSync(path.join(cache, 'f'), '1');
  assert.throws(() => removeSource({ paths, name: 'y' }), { code: 'CACHE_UNMANAGED' });
  assert.ok(fs.existsSync(cache));
  fs.writeFileSync(path.join(paths.reposCache, CACHE_MARKER), '');
  const r = removeSource({ paths, name: 'y' });
  assert.equal(r.removedCache, true);
  assert.ok(!fs.existsSync(cache));
  assert.deepEqual(loadRegistry(paths).repositories, []);
});

test('git: clone and pull use argument arrays, no shell, hooks disabled', (t) => {
  const calls = [];
  const git = createGit({ runner: (args, opts) => { calls.push({ args, cwd: opts.cwd }); return ''; } });
  git.clone('https://github.com/x/y.git', '/tmp/dest', 'dev');
  git.clone('git@github.com:x/y.git', '/tmp/dest2');
  git.pull('/tmp/dest');
  assert.deepEqual(calls[0].args, ['-c', 'core.hooksPath=.agentforge-no-hooks', 'clone', '--depth', '1', '--no-recurse-submodules', '--branch', 'dev', '--', 'https://github.com/x/y.git', '/tmp/dest']);
  assert.ok(!calls[1].args.includes('--branch'), 'no branch → git picks the remote default');
  assert.deepEqual(calls[2], { args: ['-c', 'core.hooksPath=.agentforge-no-hooks', 'pull', '--ff-only'], cwd: '/tmp/dest' });
  assert.throws(() => git.clone('ext::sh -c id', '/tmp/x'), { exitCode: 2 });
  assert.throws(() => git.clone('https://h/x', '/tmp/x', '--upload-pack=id'), { exitCode: 2 });
  assert.throws(() => git.clone('https://h/x', '--output=x'), { exitCode: 2 });
});

test('fetch: a failing source is reported, others continue, marker is written', (t) => {
  const { paths } = fakeHome(t);
  addSource({ paths, urlOrPath: 'https://h/ok.git' });
  addSource({ paths, urlOrPath: 'https://h/bad.git' });
  const git = createGit({ runner: (args) => { if (args.includes('https://h/bad.git')) { const e = new Error('boom'); e.stderr = 'fatal: nope'; throw e; } return 'abc1234'; } });
  const results = fetchSources({ paths, git });
  assert.deepEqual(results.map((r) => [r.name, r.status]), [['ok', 'cloned'], ['bad', 'failed']]);
  assert.match(results[1].error, /nope/);
  assert.ok(fs.existsSync(path.join(paths.reposCache, CACHE_MARKER)));
});

test('deploy root: an orphaned merged view (no repos.json) is ignored with a warning', (t) => {
  const { paths } = fakeHome(t);
  fs.mkdirSync(paths.mergedSkills, { recursive: true });
  const r = resolveDeployRoot({ env: {}, paths, config: {} });
  assert.equal(r.origin, 'default');
  assert.equal(r.root, path.join(paths.agentforgeDir, 'vault'));
  assert.equal(r.warnings.length, 2);
  assert.match(r.warnings[0], /orphaned view/);
  assert.match(r.warnings[1], /no vault configured/);
  fs.writeFileSync(paths.reposJson, '{"repositories":[]}');
  assert.equal(resolveDeployRoot({ env: {}, paths, config: {} }).origin, 'merged-view');
  assert.equal(resolveDeployRoot({ env: { AGENTFORGE_VAULT_ROOT: 'E' }, paths, config: {} }).origin, 'env');
  assert.equal(resolveDeployRoot({ cliVault: 'C', env: { AGENTFORGE_VAULT_ROOT: 'E' }, paths, config: {} }).origin, 'cli');
  assert.equal(resolveDeployRoot({ env: {}, paths, config: { vaultRoot: 'K' } }).origin, 'config');
});

/** A home with a built merged view and `count` registered sources. */
function homeWithLibrary(t, count) {
  const home = fakeHome(t);
  const { paths } = home;
  fs.mkdirSync(paths.mergedSkills, { recursive: true });
  const repositories = Array.from({ length: count }, (_, i) => ({ name: `src${i}`, type: 'local', url_or_path: `/s${i}` }));
  fs.writeFileSync(paths.reposJson, JSON.stringify({ repositories }));
  return home;
}

test('deploy root: a built library with registered sources beats the env var and config vaultRoot', (t) => {
  const { paths } = homeWithLibrary(t, 1);
  const viaEnv = resolveDeployRoot({ env: { AGENTFORGE_VAULT_ROOT: 'E' }, paths, config: {} });
  assert.deepEqual([viaEnv.origin, viaEnv.root, viaEnv.supersedes], ['merged-view', paths.mergedSkills, 'env']);
  const viaConfig = resolveDeployRoot({ env: {}, paths, config: { vaultRoot: 'K' } });
  assert.deepEqual([viaConfig.origin, viaConfig.root, viaConfig.supersedes], ['merged-view', paths.mergedSkills, 'config']);
  const both = resolveDeployRoot({ env: { AGENTFORGE_VAULT_ROOT: 'E' }, paths, config: { vaultRoot: 'K' } });
  assert.equal(both.supersedes, 'env', 'env is the one named when both are set, as it is the one that would have won');
  const neither = resolveDeployRoot({ env: {}, paths, config: {} });
  assert.deepEqual([neither.origin, neither.supersedes], ['merged-view', null]);
  assert.deepEqual(viaEnv.warnings, []);
});

test('deploy root: --vault still wins and never reads the registry', (t) => {
  const { paths } = homeWithLibrary(t, 1);
  fs.writeFileSync(paths.reposJson, '{ not json');
  const r = resolveDeployRoot({ cliVault: 'C', env: { AGENTFORGE_VAULT_ROOT: 'E' }, paths, config: {} });
  assert.equal(r.origin, 'cli');
});

test('deploy root: an empty registry leaves the env var and config in charge', (t) => {
  const { paths } = homeWithLibrary(t, 0);
  assert.equal(resolveDeployRoot({ env: { AGENTFORGE_VAULT_ROOT: 'E' }, paths, config: {} }).origin, 'env');
  assert.equal(resolveDeployRoot({ env: {}, paths, config: { vaultRoot: 'K' } }).origin, 'config');
});

test('deploy root: sources registered but no library built keeps env and config, and says to run repo sync', (t) => {
  const { paths } = fakeHome(t);
  fs.mkdirSync(paths.agentforgeDir, { recursive: true });
  fs.writeFileSync(paths.reposJson, JSON.stringify({ repositories: [{ name: 'a', type: 'local', url_or_path: '/a' }] }));
  const r = resolveDeployRoot({ env: { AGENTFORGE_VAULT_ROOT: 'E' }, paths, config: {} });
  assert.equal(r.origin, 'env');
  assert.equal(r.warnings.length, 1);
  assert.match(r.warnings[0], /repo sync/);
  assert.equal(resolveDeployRoot({ env: {}, paths, config: {} }).warnings.some((w) => /repo sync/.test(w) && /registered/.test(w)), true);
});

test('deploy root: a corrupt registry refuses unless --vault is given', (t) => {
  const { paths } = homeWithLibrary(t, 1);
  fs.writeFileSync(paths.reposJson, '{ not json');
  assert.throws(() => resolveDeployRoot({ env: { AGENTFORGE_VAULT_ROOT: 'E' }, paths, config: {} }), { code: 'CONFIG_CORRUPT' });
});

test('primary source for sync can never be the merged view', (t) => {
  const { paths } = fakeHome(t);
  assert.throws(() => resolvePrimarySource({ cliVault: paths.mergedSkills, env: {}, paths }), { code: 'VIEW_AS_SOURCE' });
  assert.throws(() => resolvePrimarySource({ env: { AGENTFORGE_VAULT_ROOT: paths.mergedSkills }, paths }), { code: 'VIEW_AS_SOURCE' });
});
