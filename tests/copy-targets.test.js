'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { TARGETS } = require('../src/domain/targets');
const { planProject, inspectProject } = require('../src/application/project');
const { applyPlan } = require('../src/deployment/apply');
const { copyState, readMarker, MARKER } = require('../src/deployment/copy-state');
const { inspectDestination } = require('../src/infra/fs-inspect');
const { tempRoot, makeVault, mkLink } = require('./helpers');

const REPO = path.resolve(__dirname, '..');
function plan(project, vault, targetSelector, extra = {}) {
  return planProject({ projectRoot: project, targetSelector, vars: {}, templatesDir: path.join(REPO, 'templates'), vaultRoot: vault, withDoc: false, ...extra });
}
const kinds = (plans) => plans.flatMap((p) => p.actions.map((a) => `${p.target}:${a.kind}`));

test('antigravity cannot follow links, so its skills folder is a recorded copy', (t) => {
  const root = tempRoot(t);
  const vault = makeVault(root, 'vault', ['a', 'b']);
  const project = path.join(root, 'proj'); fs.mkdirSync(project);
  const plans = plan(project, vault, 'antigravity');
  assert.deepEqual(kinds(plans), ['antigravity:mkdir', 'antigravity:copy-directory', 'antigravity:append-gitignore']);
  for (const p of plans) applyPlan(p);
  const skills = path.join(project, '.agents', 'skills');
  assert.equal(inspectDestination(skills).kind, 'directory');
  assert.ok(fs.existsSync(path.join(skills, 'a', 'SKILL.md')));
  const marker = readMarker(path.join(project, '.agents'));
  assert.deepEqual(marker.names, ['a', 'b']);
  assert.ok(!fs.existsSync(path.join(skills, MARKER)), 'the marker sits beside the skills folder, not in it');
  const ignored = fs.readFileSync(path.join(project, '.gitignore'), 'utf8').split('\n');
  assert.ok(ignored.includes('.agents/skills') && ignored.includes(`.agents/${MARKER}`), 'the copy and its machine-specific marker are both ignored');
  assert.equal(copyState(path.join(project, '.agents'), vault).state, 'fresh');
  assert.deepEqual(kinds(plan(project, vault, 'antigravity')), [], 'a fresh copy needs nothing');
});

test('a stale copy is detected and refreshed; skills the user added are kept', (t) => {
  const root = tempRoot(t);
  const vault = makeVault(root, 'vault', ['a', 'b']);
  const project = path.join(root, 'proj'); fs.mkdirSync(project);
  for (const p of plan(project, vault, 'antigravity')) applyPlan(p);
  const skills = path.join(project, '.agents', 'skills');
  fs.mkdirSync(path.join(skills, 'mine')); fs.writeFileSync(path.join(skills, 'mine', 'SKILL.md'), 'local');

  fs.appendFileSync(path.join(vault, 'a', 'SKILL.md'), 'edited in the library\n');
  fs.rmSync(path.join(vault, 'b'), { recursive: true });
  makeVault(root, 'vault', ['c']);
  assert.equal(copyState(path.join(project, '.agents'), vault).state, 'stale');
  const report = inspectProject({ projectRoot: project, vaultRoot: vault }).targets.find((x) => x.id === 'antigravity');
  assert.match(report.linkHealth, /out of date/);

  const plans = plan(project, vault, 'antigravity');
  assert.deepEqual(kinds(plans), ['antigravity:refresh-copy']);
  for (const p of plans) applyPlan(p);
  assert.match(fs.readFileSync(path.join(skills, 'a', 'SKILL.md'), 'utf8'), /edited in the library/);
  assert.ok(!fs.existsSync(path.join(skills, 'b')), 'a skill removed from the library leaves the copy');
  assert.ok(fs.existsSync(path.join(skills, 'c', 'SKILL.md')), 'a new library skill arrives');
  assert.equal(fs.readFileSync(path.join(skills, 'mine', 'SKILL.md'), 'utf8'), 'local', 'the user-added skill is untouched');
  assert.equal(copyState(path.join(project, '.agents'), vault).state, 'fresh');
});

test('generic and antigravity share .agents: planned once, as a copy', (t) => {
  const root = tempRoot(t);
  const vault = makeVault(root, 'vault', ['a']);
  const project = path.join(root, 'proj'); fs.mkdirSync(project);
  const plans = plan(project, vault, ['generic', 'antigravity']);
  assert.deepEqual(kinds(plans), ['generic:mkdir', 'generic:copy-directory', 'generic:append-gitignore']);
  assert.match(plans[1].notes.join(' '), /shared with generic/);
  for (const p of plans) applyPlan(p);
  assert.equal(inspectDestination(path.join(project, '.agents', 'skills')).kind, 'directory');
});

test('an existing link to the same library is swapped for a copy without --force; the library is untouched', (t) => {
  const root = tempRoot(t);
  const vault = makeVault(root, 'vault', ['a']);
  const project = path.join(root, 'proj');
  fs.mkdirSync(path.join(project, '.agents'), { recursive: true });
  mkLink(vault, path.join(project, '.agents', 'skills'));
  const before = inspectProject({ projectRoot: project, vaultRoot: vault }).targets.find((x) => x.id === 'antigravity');
  assert.equal(before.needsCopy, true);
  assert.match(before.linkHealth, /needs a copy/);
  const plans = plan(project, vault, 'antigravity');
  assert.deepEqual(kinds(plans), ['antigravity:remove-link', 'antigravity:copy-directory', 'antigravity:append-gitignore']);
  for (const p of plans) applyPlan(p);
  assert.ok(fs.existsSync(path.join(vault, 'a', 'SKILL.md')));
  assert.equal(inspectDestination(path.join(project, '.agents', 'skills')).kind, 'directory');
});

test('a project copied before the marker was ignored gets the missing line on the next run', (t) => {
  const root = tempRoot(t);
  const vault = makeVault(root, 'vault', ['a']);
  const project = path.join(root, 'proj'); fs.mkdirSync(project);
  for (const p of plan(project, vault, 'antigravity')) applyPlan(p);
  fs.writeFileSync(path.join(project, '.gitignore'), '# agentforge generated\n.agents/skills\n');
  const plans = plan(project, vault, 'antigravity');
  assert.deepEqual(plans[0].actions.map((a) => [a.kind, a.lines]), [['append-gitignore', [`.agents/${MARKER}`]]]);
  for (const p of plans) applyPlan(p);
  assert.deepEqual(kinds(plan(project, vault, 'antigravity')), [], 'and then nothing more');
});

test('cursor is an ordinary link target; neither new target is part of "all"', (t) => {
  const root = tempRoot(t);
  const vault = makeVault(root, 'vault', ['a']);
  const project = path.join(root, 'proj'); fs.mkdirSync(project);
  assert.deepEqual(kinds(plan(project, vault, 'cursor')), ['cursor:mkdir', 'cursor:create-link', 'cursor:append-gitignore']);
  assert.deepEqual(plan(project, vault, 'all').map((p) => p.target), ['claude', 'codex', 'generic', 'gemini']);
  assert.equal(TARGETS.antigravity.copyOnly, true);
});
