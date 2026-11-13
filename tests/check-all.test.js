'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { run } = require('../src/cli/main');
const { fixture } = require('./dashboard-fixtures');
const { mkLink } = require('./helpers');

const sink = () => { let text = ''; return { write: (s) => { text += s; }, isTTY: false, get text() { return text; } }; };

/** Three projects wired to the library in different ways, and the fixture's own project, whose agents read other folders. */
function setup(t) {
  const f = fixture(t);
  const merged = path.join(f.homedir, '.agentforge', 'merged-skills');
  const project = (name, agents) => {
    const dir = path.join(f.root, name);
    for (const a of ['.claude', '.codex']) fs.mkdirSync(path.join(dir, a), { recursive: true });
    for (const a of agents) mkLink(merged, path.join(dir, a, 'skills'));
    return dir;
  };
  const a = project('app-a', ['.claude', '.codex']), b = project('app-b', ['.claude']), c = project('app-c', []);
  fs.writeFileSync(path.join(f.homedir, '.agentforge', 'projects.json'), JSON.stringify({ projects: [a, b, c, f.project] }));
  return { f, merged, a, b, c };
}
function check(f, argv, verifyRun) {
  const stdout = sink(), stderr = sink();
  // The fake tool answers with every skill it can see in the library.
  const code = run(['check', ...argv], { homedir: f.homedir, env: {}, stdout, stderr, cwd: f.root, verifyRun: verifyRun || (() => fs.readdirSync(path.join(f.homedir, '.agentforge', 'merged-skills')).join('\n')) });
  return { code, out: stdout.text, err: stderr.text };
}

test('check asks every working agent in every remembered project, and only those', (t) => {
  const { f } = setup(t);
  const asked = [];
  const r = check(f, ['--json'], (command, args, opts) => { asked.push(path.basename(opts.cwd) + ':' + command); return fs.readdirSync(path.join(f.homedir, '.agentforge', 'merged-skills')).join('\n'); });
  assert.equal(r.code, 0, r.err);
  assert.deepEqual(asked.sort(), ['app-a:claude', 'app-a:codex', 'app-b:claude'], 'app-c has nothing wired, and the fixture project reads the vault, not the library');
  const results = JSON.parse(r.out);
  assert.deepEqual(results.map((x) => x.level), ['verified', 'verified', 'verified']);
});

test('check --dry-run lists what would be asked and asks nothing', (t) => {
  const { f } = setup(t);
  let asked = 0;
  const r = check(f, ['--dry-run'], () => { asked++; return ''; });
  assert.equal(r.code, 0);
  assert.equal(asked, 0);
  assert.match(r.out, /would ask 3 agents/);
  assert.match(r.out, /app-a/); assert.match(r.out, /app-b/);
});

test('one agent that cannot be asked does not stop the others, and the exit code says so', (t) => {
  const { f } = setup(t);
  let calls = 0;
  const r = check(f, ['--json'], () => { calls++; if (calls === 2) throw Object.assign(new Error('spawn ENOENT'), { code: 'ENOENT' }); return fs.readdirSync(path.join(f.homedir, '.agentforge', 'merged-skills')).join('\n'); });
  assert.equal(calls, 3, 'all three were still asked');
  assert.equal(r.code, 1);
  assert.deepEqual(JSON.parse(r.out).map((x) => x.level).sort(), ['unavailable', 'verified', 'verified']);
});

test('check --path limits it to one project; with no projects it explains instead of failing', (t) => {
  const { f, a } = setup(t);
  const asked = [];
  const one = check(f, ['--path', a, '--json'], (command, args, opts) => { asked.push(path.basename(opts.cwd)); return fs.readdirSync(path.join(f.homedir, '.agentforge', 'merged-skills')).join('\n'); });
  assert.equal(one.code, 0);
  assert.deepEqual(asked, ['app-a', 'app-a']);

  fs.rmSync(path.join(f.homedir, '.agentforge', 'projects.json'));
  const none = check(f, []);
  assert.equal(none.code, 0);
  assert.match(none.out, /no projects/i);
});

test('update is the same as repo sync: fetch every Git source, then rebuild the library', (t) => {
  const { f } = setup(t);
  const stdout = sink(), stderr = sink();
  const code = run(['update', '--no-fetch'], { homedir: f.homedir, env: {}, stdout, stderr, cwd: f.root });
  assert.equal(code, 0, stderr.text);
  assert.match(stdout.text, /agentforge update/);
  assert.match(stdout.text, /merged view built/);
});
