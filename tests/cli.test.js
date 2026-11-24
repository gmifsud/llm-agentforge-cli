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

test('doctor reports whether skills can be invoked: rule problems, listing budget, personal shadowing', (t) => {
  const root = tempRoot(t);
  const home = path.join(root, 'home'); fs.mkdirSync(home);
  const vault = path.join(root, 'vault');
  const write = (dir, text) => { fs.mkdirSync(dir, { recursive: true }); fs.writeFileSync(path.join(dir, 'SKILL.md'), text); };
  write(path.join(vault, 'good'), `---\nname: good\ndescription: ${'d'.repeat(60)}\n---\n`);
  write(path.join(vault, 'wrong-folder'), '---\nname: something-else\ndescription: d\n---\n');
  write(path.join(vault, 'tdd'), `---\nname: tdd\ndescription: ${'d'.repeat(60)}\n---\n`);
  write(path.join(home, '.claude', 'skills', 'tdd'), '---\nname: tdd\ndescription: mine\n---\n');
  fs.mkdirSync(path.join(home, '.agentforge'));
  fs.writeFileSync(path.join(home, '.agentforge', 'config.json'), JSON.stringify({ listingBudgetChars: 100 }));

  const json = JSON.parse(cli(['doctor', '--path', root, '--vault', vault, '--json'], { home }).out);
  assert.equal(json.library.skills, 3);
  assert.deepEqual(json.library.findings.map((f) => `${f.skill}:${f.code}`), ['something-else:NAME_MISMATCH']);
  assert.deepEqual({ fits: json.library.budget.fits, dropped: json.library.budget.dropped }, { fits: false, dropped: 1 });
  assert.deepEqual(json.library.shadows.map((s) => `${s.tool}:${s.name}`), ['claude:tdd']);

  const text = cli(['doctor', '--path', root, '--vault', vault], { home });
  assert.equal(text.code, 0, 'health findings inform; they do not fail doctor');
  assert.match(text.out, /1 will not load in some tools/);
  assert.match(text.out, /at least 1 of 3 descriptions will not be shown/);
  assert.match(text.out, /tdd: your personal claude skill .* takes precedence/);
});

test('doctor counts a vault that mixes ordinary skill folders with a linked one', (t) => {
  const root = tempRoot(t);
  const home = path.join(root, 'home'); fs.mkdirSync(home);
  const vault = makeVault(root, 'vault', ['a', 'b']);
  const elsewhere = makeVault(root, 'elsewhere', ['linked-skill']);
  mkLink(path.join(elsewhere, 'linked-skill'), path.join(vault, 'linked-skill'));
  const report = JSON.parse(cli(['doctor', '--path', root, '--vault', vault, '--json'], { home }).out);
  assert.equal(report.vault.skills, 3, 'two folders plus one link, not just the link');
  assert.equal(report.vault.viewLinks, 1);
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

test('with AGENTFORGE_VAULT_ROOT set, init and link wire the library when sources are registered; --vault still wins', (t) => {
  const root = tempRoot(t);
  const home = path.join(root, 'home'); fs.mkdirSync(home);
  const vault = makeVault(root, 'vault', ['own']);
  const ext = makeVault(root, 'ext', ['extra']);
  const env = { AGENTFORGE_VAULT_ROOT: vault };
  assert.equal(cli(['repo', 'add', ext, '--name', 'ext'], { home, env }).code, 0);
  assert.equal(cli(['repo', 'sync', '--no-fetch'], { home, env }).code, 0);
  const view = path.join(home, '.agentforge', 'merged-skills');

  const fresh = path.join(root, 'fresh'); fs.mkdirSync(fresh);
  const init = cli(['init', '--path', fresh], { home, env });
  assert.equal(init.code, 0, init.err);
  assert.match(init.out, /merged-skills \(merged-view\)/);
  assert.match(init.out, /AGENTFORGE_VAULT_ROOT .*primary vault for "repo sync".*--vault/);
  assert.deepEqual(fs.readdirSync(path.join(fresh, '.claude', 'skills')).sort(), ['extra', 'own'], 'the registered source reaches the project');
  assert.equal(fs.realpathSync(path.join(fresh, '.claude', 'skills')), fs.realpathSync(view));

  const alone = path.join(root, 'alone'); fs.mkdirSync(alone);
  const explicit = cli(['init', '--path', alone, '--vault', vault], { home, env });
  assert.equal(explicit.code, 0, explicit.err);
  assert.deepEqual(fs.readdirSync(path.join(alone, '.claude', 'skills')), ['own'], '--vault wires the vault alone');
  assert.doesNotMatch(explicit.out, /primary vault for "repo sync"/);

  // A project already wired to the vault is not repointed behind the owner's back.
  const before = snapshot(alone);
  const link = cli(['link', '--path', alone], { home, env });
  assert.equal(link.code, 3, link.err);
  assert.match(link.err, /--force/);
  assert.deepEqual(snapshot(alone), before);
});

test('link refuses a --path that is not an existing folder, and init refuses one that is a file; neither creates anything', (t) => {
  const root = tempRoot(t);
  const home = path.join(root, 'home'); fs.mkdirSync(home);
  const vault = makeVault(root, 'vault', ['a']);
  const project = path.join(root, 'proj'); fs.mkdirSync(project);
  fs.writeFileSync(path.join(root, 'a-file'), 'x');
  const before = snapshot(root);

  // A relative path is resolved against the folder the command runs from, so this one is proj/proj, which does not exist.
  const nested = cli(['link', '--path', 'proj', '--vault', vault], { home, cwd: project });
  assert.equal(nested.code, 2, nested.out + nested.err);
  assert.match(nested.err, /not an existing folder/);
  assert.match(nested.err, /proj[\\/]proj/);
  assert.equal(cli(['link', '--path', path.join(root, 'nope'), '--vault', vault, '--dry-run'], { home }).code, 2, 'also on a dry run');
  for (const command of ['link', 'init']) assert.equal(cli([command, '--path', path.join(root, 'a-file'), '--vault', vault], { home }).code, 2, `${command} on a file`);
  assert.deepEqual(snapshot(root), before, 'nothing was created');

  assert.equal(cli(['link', '--path', '.', '--vault', vault], { home, cwd: project }).code, 0, 'an existing folder still works');
  const fresh = cli(['init', '--path', path.join(root, 'new-project'), '--vault', vault], { home });
  assert.equal(fresh.code, 0, 'init may still start a project in a folder that does not exist yet');
});

test('repo sync --no-fetch builds kept copies and says so; with no rules it stays quiet about them', (t) => {
  const root = tempRoot(t);
  const home = path.join(root, 'home'); fs.mkdirSync(path.join(home, '.agentforge'), { recursive: true });
  const vault = makeVault(root, 'vault', ['tdd']);
  const ext = makeVault(root, 'ext', ['tdd']);
  const env = { AGENTFORGE_VAULT_ROOT: vault };
  assert.equal(cli(['repo', 'add', ext, '--name', 'ext'], { home, env }).code, 0);
  const quiet = cli(['repo', 'sync', '--no-fetch'], { home, env });
  assert.equal(quiet.code, 0, quiet.err);
  assert.doesNotMatch(quiet.out, /kept cop/);

  const { digestSkill } = require('../src/discovery/skill-digest');
  const rule = { name: 'tdd-ext', from: { skill: 'tdd', source: 'ext' }, description: 'The ext copy.', digest: digestSkill(path.join(ext, 'tdd')).digest, keptAt: 'now' };
  fs.writeFileSync(path.join(home, '.agentforge', 'config.json'), JSON.stringify({ kept: [rule, { ...rule, name: 'tdd-gone', from: { skill: 'tdd', source: 'nowhere' } }] }));
  const sync = cli(['repo', 'sync', '--no-fetch'], { home, env });
  assert.equal(sync.code, 0, sync.err);
  assert.match(sync.out, /kept copies: 1 built/);
  assert.match(sync.err + sync.out, /tdd-gone: kept copy not built \(original not found\)/);
  assert.ok(fs.existsSync(path.join(home, '.agentforge', 'kept', 'tdd-ext', 'SKILL.md')));
});

test('repo sync warns about a previous kept folder it could not remove, and still succeeds', (t) => {
  const root = tempRoot(t);
  const home = path.join(root, 'home'); fs.mkdirSync(path.join(home, '.agentforge'), { recursive: true });
  const vault = makeVault(root, 'vault', ['tdd']);
  const ext = makeVault(root, 'ext', ['tdd']);
  const env = { AGENTFORGE_VAULT_ROOT: vault };
  assert.equal(cli(['repo', 'add', ext, '--name', 'ext'], { home, env }).code, 0);
  const { digestSkill } = require('../src/discovery/skill-digest');
  const rule = { name: 'tdd-ext', from: { skill: 'tdd', source: 'ext' }, description: 'The ext copy.', digest: digestSkill(path.join(ext, 'tdd')).digest, keptAt: 'now' };
  fs.writeFileSync(path.join(home, '.agentforge', 'config.json'), JSON.stringify({ kept: [rule] }));
  assert.equal(cli(['repo', 'sync', '--no-fetch'], { home, env }).code, 0);
  const rmSync = fs.rmSync;
  t.mock.method(fs, 'rmSync', (p, o) => { if (/kept\.old-\d+$/.test(String(p))) throw new Error('EBUSY: resource busy'); return rmSync(p, o); });
  const sync = cli(['repo', 'sync', '--no-fetch'], { home, env });
  t.mock.restoreAll();
  assert.equal(sync.code, 0, sync.err);
  const old = path.join(home, '.agentforge', `kept.old-${process.pid}`);
  assert.match(sync.err + sync.out, /could not remove the previous kept copies/);
  assert.ok((sync.err + sync.out).includes(old));
  fs.rmSync(old, { recursive: true, force: true });
});
