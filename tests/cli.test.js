'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { run } = require('../src/cli/main');
const { inspectDestination } = require('../src/infra/fs-inspect');
const { tempRoot, makeVault, mkLink, snapshot } = require('./helpers');

const REPO = path.resolve(__dirname, '..');

function sink() { let s = ''; return { write: (x) => { s += x; return true; }, text: () => s, isTTY: false }; }

function cli(argv, { home, cwd, env = {}, git } = {}) {
  const out = sink(); const err = sink();
  const code = run(argv, { env: { NO_COLOR: '1', ...env }, homedir: home, scriptDir: REPO, stdout: out, stderr: err, cwd, git });
  return { code, out: out.text(), err: err.text() };
}

test('init --dry-run writes nothing; init writes doc, link and gitignore; doctor passes', (t) => {
  const root = tempRoot(t);
  const home = path.join(root, 'home'); fs.mkdirSync(home);
  const vault = makeVault(root, 'vault', ['a', 'b']);
  const project = path.join(root, 'proj'); fs.mkdirSync(project);

  const before = snapshot(root);
  const dry = cli(['init', '--path', project, '--vault', vault, '--name', 'demo', '--build', 'pnpm build && pnpm test', '--dry-run'], { home });
  assert.equal(dry.code, 0, dry.err);
  assert.match(dry.out, /\(dry\) would write/);
  assert.deepEqual(snapshot(root), before);

  const real = cli(['init', '-Path', project, '-VaultRoot', vault, '-Name', 'demo', '-BuildCmd', 'pnpm build && pnpm test'], { home });
  assert.equal(real.code, 0, real.err);
  const doc = fs.readFileSync(path.join(project, 'CLAUDE.md'), 'utf8');
  assert.match(doc, /# demo/);
  assert.match(doc, /pnpm build && pnpm test/);
  assert.equal(inspectDestination(path.join(project, '.claude', 'skills')).kind, 'link');
  assert.match(fs.readFileSync(path.join(project, '.gitignore'), 'utf8'), /\.claude\/skills/);

  const again = cli(['init', '--path', project, '--vault', vault], { home });
  assert.equal(again.code, 0);
  assert.match(again.out, /already exists|up to date/);

  const doc2 = cli(['doctor', '--path', project, '--vault', vault, '--json'], { home });
  assert.equal(doc2.code, 0, doc2.err);
  const report = JSON.parse(doc2.out);
  assert.equal(report.vault.skills, 2);
  assert.equal(report.targets.find((x) => x.id === 'claude').linkHealth, 'link');
});

test('link into a project already linked to another vault exits 3 and changes nothing', (t) => {
  const root = tempRoot(t);
  const home = path.join(root, 'home'); fs.mkdirSync(home);
  const oldVault = makeVault(root, 'old', ['x']);
  const newVault = makeVault(root, 'new', ['x', 'y']);
  const project = path.join(root, 'proj');
  fs.mkdirSync(path.join(project, '.claude'), { recursive: true });
  mkLink(oldVault, path.join(project, '.claude', 'skills'));
  const before = snapshot(root);
  const r = cli(['link', '--path', project, '--vault', newVault], { home });
  assert.equal(r.code, 3);
  assert.match(r.err, /another source/);
  assert.deepEqual(snapshot(root), before);
});

test('init --target all writes AGENTS.md once and links four folders', (t) => {
  const root = tempRoot(t);
  const home = path.join(root, 'home'); fs.mkdirSync(home);
  const vault = makeVault(root, 'vault', ['a']);
  const project = path.join(root, 'proj');
  const r = cli(['init', '--path', project, '--vault', vault, '--target', 'all'], { home });
  assert.equal(r.code, 0, r.err);
  for (const d of ['.claude', '.codex', '.agents', '.gemini']) assert.equal(inspectDestination(path.join(project, d, 'skills')).kind, 'link', d);
  for (const f of ['CLAUDE.md', 'AGENTS.md', 'GEMINI.md']) assert.ok(fs.existsSync(path.join(project, f)), f);
});

test('repo add/list/sync --no-fetch builds the view; doctor then uses it; remove keeps local source', (t) => {
  const root = tempRoot(t);
  const home = path.join(root, 'home'); fs.mkdirSync(home);
  const vault = makeVault(root, 'vault', ['own', 'tdd']);
  const ext = makeVault(root, 'ext', ['tdd', 'extra']);
  const project = path.join(root, 'proj'); fs.mkdirSync(project);
  const env = { AGENTFORGE_VAULT_ROOT: vault };

  assert.equal(cli(['repo', 'add', ext, '--name', 'ext'], { home, env }).code, 0);
  const list = cli(['repo', 'list', '--json'], { home, env });
  assert.equal(JSON.parse(list.out)[0].skills, 2);

  const dry = cli(['repo', 'sync', '--no-fetch', '--dry-run'], { home, env });
  assert.equal(dry.code, 0, dry.err);
  assert.ok(!fs.existsSync(path.join(home, '.agentforge', 'merged-skills')));

  const sync = cli(['repo', 'sync', '--no-fetch'], { home, env });
  assert.equal(sync.code, 0, sync.err);
  assert.match(sync.out, /tdd: kept vault, dropped ext/);
  const view = path.join(home, '.agentforge', 'merged-skills');
  assert.deepEqual(fs.readdirSync(view).sort(), ['extra', 'own', 'tdd']);

  // deploy from the view (no env override → merged-view since repos.json exists)
  const init = cli(['init', '--path', project], { home });
  assert.equal(init.code, 0, init.err);
  assert.match(init.out, /merged-view/);
  const doc = cli(['doctor', '--path', project, '--json'], { home });
  assert.equal(JSON.parse(doc.out).vault.skills, 3);

  assert.equal(cli(['repo', 'remove', 'ext'], { home, env }).code, 0);
  assert.ok(fs.existsSync(path.join(ext, 'extra', 'SKILL.md')), 'local source untouched');
});
