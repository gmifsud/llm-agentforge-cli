'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { ReadService } = require('../dashboard/server/read-service');
const { fixture, contentSnapshot } = require('./dashboard-fixtures');
const { mkLink } = require('./helpers');

test('review: revision lookup must not follow metadata outside the cached source', t => {
  const f = fixture(t), cached = path.join(f.homedir, '.agentforge/repos/cached');
  const external = path.join(f.root, 'external-git');
  fs.mkdirSync(path.join(external, 'objects'), { recursive: true });
  fs.mkdirSync(path.join(external, 'refs/heads'), { recursive: true });
  fs.writeFileSync(path.join(external, 'HEAD'), 'ref: refs/heads/main\n');
  fs.writeFileSync(path.join(external, 'refs/heads/main'), '1234567890abcdef1234567890abcdef12345678\n');
  fs.mkdirSync(cached, { recursive: true }); mkLink(external, path.join(cached, '.git'));
  fs.writeFileSync(f.registry, JSON.stringify({ repositories: [{ name: 'cached', type: 'git', url_or_path: 'https://example.com/cached' }] }));
  const before = contentSnapshot(f.root);
  const c = new ReadService(f.options).refresh();
  assert.equal(c.sources[1].revision, null);
  assert.deepEqual(contentSnapshot(f.root), before);
});

test('review: context validates merged-view links before probing their targets', t => {
  if (process.platform !== 'win32') return;
  const f = fixture(t), merged = path.join(f.homedir, '.agentforge/merged-skills');
  fs.writeFileSync(path.join(f.homedir, '.agentforge/config.json'), '{}');
  // Isolated, deliberately absent path: no network or WSL operation is performed.
  const probe = path.join(f.root, 'blocked');
  const originalExists = fs.existsSync;
  const service = new ReadService({ ...f.options, vault: undefined });
  // Redirect only the path table rather than touching the real merged-view fixtures.
  service.paths = { ...service.paths, mergedSkills: probe };
  fs.symlinkSync('\\\\wsl.localhost\\UnopenedDistribution\\skills', probe, 'dir');
  let probed = false;
  t.mock.method(fs, 'existsSync', p => {
    if (p === probe) { probed = true; return false; }
    return originalExists(p);
  });
  assert.throws(() => service.context(), { status: 403 });
  assert.equal(probed, false);
});

test('review: malformed source URI cannot leak a query credential through fallback', t => {
  const f = fixture(t);
  fs.writeFileSync(f.registry, JSON.stringify({ repositories: [{ name: 'cached', type: 'git', url_or_path: 'git@example.com:repo?token=private-value' }] }));
  assert.equal(JSON.stringify(new ReadService(f.options).refresh()).includes('private-value'), false);
});

test('review: bounded revision reads support detached and packed refs and reject an escaping ref', t => {
  const f = fixture(t), cached = path.join(f.homedir, '.agentforge/repos/cached'), gitRoot = path.join(cached, '.git');
  fs.mkdirSync(gitRoot, { recursive: true });
  fs.writeFileSync(f.registry, JSON.stringify({ repositories: [{ name: 'cached', type: 'git', url_or_path: 'https://example.com/cached' }] }));
  const headFile = path.join(gitRoot, 'HEAD'), hash = 'abcdef0123456789abcdef0123456789abcdef01';
  fs.writeFileSync(headFile, hash + '\n');
  const service = new ReadService(f.options);
  assert.equal(service.refresh().sources[1].revision, hash);
  fs.writeFileSync(headFile, 'ref: refs/heads/main\n');
  fs.writeFileSync(path.join(gitRoot, 'packed-refs'), `# pack-refs with: peeled fully-peeled sorted\n${hash} refs/heads/main\n`);
  assert.equal(service.refresh().sources[1].revision, hash);
  fs.mkdirSync(path.join(gitRoot, 'refs/heads'), { recursive: true });
  const outside = path.join(f.root, 'outside-ref'); fs.writeFileSync(outside, hash + '\n');
  fs.symlinkSync(outside, path.join(gitRoot, 'refs/heads/main'), 'file');
  assert.equal(service.refresh().sources[1].revision, null);
});

test('review: explicit vault precedence does not probe an unused merged-view fallback', t => {
  const f = fixture(t), service = new ReadService(f.options);
  const unused = path.join(f.root, 'unused-fallback');
  fs.symlinkSync('\\\\server.invalid\\unopened-share', unused, 'dir');
  service.paths = { ...service.paths, mergedSkills: unused };
  assert.equal(service.context().primaryRoot, f.vault);
});
