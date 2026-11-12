'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { verifyTarget, sampleSkills, question } = require('../src/application/verify');
const { tempRoot, makeVault, mkLink, snapshot } = require('./helpers');

function project(t, skills) {
  const root = tempRoot(t);
  const vault = makeVault(root, 'vault', skills);
  const proj = path.join(root, 'proj');
  fs.mkdirSync(path.join(proj, '.claude'), { recursive: true });
  mkLink(vault, path.join(proj, '.claude', 'skills'));
  return { root, proj };
}
const answer = (text) => () => text;

test('samples first, middle and last skill; the question is plain words only', (t) => {
  const { proj } = project(t, ['a', 'b', 'c', 'd', 'e']);
  assert.deepEqual(sampleSkills(path.join(proj, '.claude', 'skills')), ['a', 'c', 'e']);
  assert.match(question(['a', 'zz-agentforge-control-ab12cd']), /^[A-Za-z0-9 .,:_-]+$/);
});

test('verified when the tool reports every sampled skill and not the made-up one; nothing is written', (t) => {
  const { root, proj } = project(t, ['alpha', 'beta', 'gamma']);
  const before = snapshot(root);
  let seen;
  const r = verifyTarget({ projectRoot: proj, target: 'claude', control: 'zz-control', run: (cmd, args, opts) => { seen = { cmd, args, cwd: opts.cwd }; return 'alpha\nbeta\ngamma\n'; } });
  assert.deepEqual({ level: r.level, found: r.found, control: r.control, tool: r.tool }, { level: 'verified', found: ['alpha', 'beta', 'gamma'], control: false, tool: 'claude' });
  assert.equal(seen.cmd, 'claude');
  assert.equal(seen.cwd, proj);
  assert.match(seen.args[1], /alpha, beta, gamma, zz-control/);
  assert.ok(!seen.args.some((a) => /dangerously|force|yolo|bypass/.test(a)), 'no permission-bypass flags');
  assert.deepEqual(snapshot(root), before);
});

test('partial, not listed, and an answer that cannot be trusted are told apart', (t) => {
  const { proj } = project(t, ['alpha', 'beta', 'gamma']);
  const run = (text) => verifyTarget({ projectRoot: proj, target: 'claude', control: 'zz-control', run: answer(text) });
  assert.equal(run('alpha').level, 'partial');
  assert.equal(run('NONE').level, 'not-listed');
  assert.equal(run('alpha\nbeta\ngamma\nzz-control').level, 'unreliable');
  // A longer name that merely contains a sampled one does not count.
  assert.equal(run('alphabet\nbeta-two\ngamma').found.join(), 'gamma');
});

test('a listing command is never asked about the control; codex is read-only; cursor only trusts when told to', (t) => {
  const { root, proj } = project(t, ['alpha']);
  fs.mkdirSync(path.join(proj, '.gemini')); mkLink(path.join(root, 'vault'), path.join(proj, '.gemini', 'skills'));
  fs.mkdirSync(path.join(proj, '.codex')); mkLink(path.join(root, 'vault'), path.join(proj, '.codex', 'skills'));
  fs.mkdirSync(path.join(proj, '.cursor')); mkLink(path.join(root, 'vault'), path.join(proj, '.cursor', 'skills'));
  const calls = [];
  const run = (cmd, args) => { calls.push({ cmd, args }); return 'alpha zz-control'; };
  assert.equal(verifyTarget({ projectRoot: proj, target: 'gemini', control: 'zz-control', run }).level, 'verified', 'a listing cannot invent the control');
  assert.deepEqual(calls[0], { cmd: 'gemini', args: ['skills', 'list'] });
  verifyTarget({ projectRoot: proj, target: 'codex', run });
  assert.deepEqual(calls[1].args.slice(0, 4), ['exec', '--skip-git-repo-check', '-s', 'read-only']);
  verifyTarget({ projectRoot: proj, target: 'cursor', run });
  assert.ok(!calls[2].args.includes('--trust'));
  verifyTarget({ projectRoot: proj, target: 'cursor', run, trustWorkspace: true });
  assert.ok(calls[3].args.includes('--trust'));
});

test('not wired and unavailable are reported, not thrown', (t) => {
  const { proj } = project(t, ['alpha']);
  assert.equal(verifyTarget({ projectRoot: proj, target: 'gemini', run: answer('') }).level, 'not-wired');
  const missing = verifyTarget({ projectRoot: proj, target: 'claude', run: () => { const e = new Error('x'); e.code = 'ENOENT'; throw e; } });
  assert.deepEqual({ level: missing.level, detail: missing.detail }, { level: 'unavailable', detail: 'claude is not installed or not on PATH' });
  assert.throws(() => verifyTarget({ projectRoot: proj, target: 'nope' }), { exitCode: 2 });
  assert.throws(() => verifyTarget({ projectRoot: proj, target: 'claude', tool: 'nope' }), { exitCode: 2 });
  // The shared .agents folder is read by several tools, so the tool can be named.
  fs.mkdirSync(path.join(proj, '.agents')); fs.mkdirSync(path.join(proj, '.agents', 'skills', 'alpha'), { recursive: true });
  fs.writeFileSync(path.join(proj, '.agents', 'skills', 'alpha', 'SKILL.md'), 'x');
  assert.equal(verifyTarget({ projectRoot: proj, target: 'generic', tool: 'antigravity', run: answer('alpha') }).tool, 'antigravity');
});
