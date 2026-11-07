'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { TARGETS } = require('../src/domain/targets');
const { newPlan, planSkillsLink, planGitignore, planDoc } = require('../src/deployment/plan');
const { applyPlan } = require('../src/deployment/apply');
const { inspectDestination } = require('../src/infra/fs-inspect');
const { tempRoot, makeVault, mkLink, snapshot, IS_WIN } = require('./helpers');

const claude = TARGETS.claude;
const linkType = IS_WIN ? 'junction' : 'symlink';

function planLink(projectRoot, vault, extra = {}) {
  return planSkillsLink(newPlan(claude, projectRoot), { projectRoot, target: claude, vaultRoot: vault, linkType, ...extra });
}

test('missing destination → create link; applying twice is a no-op', (t) => {
  const root = tempRoot(t);
  const vault = makeVault(root, 'vault', ['a']);
  const project = path.join(root, 'proj');
  const p1 = planLink(project, vault);
  assert.deepEqual(p1.actions.map((a) => a.kind), ['mkdir', 'create-link']);
  applyPlan(p1);
  const before = snapshot(root);
  const p2 = planLink(project, vault);
  assert.equal(p2.actions.length, 0);
  assert.equal(p2.conflicts.length, 0);
  applyPlan(p2);
  assert.deepEqual(snapshot(root), before);
});

test('dry run performs no writes at all', (t) => {
  const root = tempRoot(t);
  const vault = makeVault(root, 'vault', ['a']);
  const project = path.join(root, 'proj');
  fs.mkdirSync(project);
  const before = snapshot(root);
  const plan = planLink(project, vault);
  const res = applyPlan(plan, { dryRun: true });
  assert.ok(res.applied.every((a) => a.dry));
  assert.deepEqual(snapshot(root), before);
});

test('link to another vault: conflict without --force, and NEVER merged into (bug D)', (t) => {
  const root = tempRoot(t);
  const oldVault = makeVault(root, 'old-vault', ['x']);
  const newVault = makeVault(root, 'new-vault', ['x', 'y']);
  const project = path.join(root, 'proj');
  fs.mkdirSync(path.join(project, '.claude'), { recursive: true });
  mkLink(oldVault, path.join(project, '.claude', 'skills'));

  const plan = planLink(project, newVault, { preserve: true });
  assert.equal(plan.actions.length, 0);
  assert.equal(plan.conflicts.length, 1);
  assert.match(plan.conflicts[0].reason, /another source/);
  assert.throws(() => applyPlan(plan), { exitCode: 3 });
  assert.deepEqual(fs.readdirSync(oldVault), ['x'], 'old vault must not receive y');

  const forced = planLink(project, newVault, { preserve: true, force: true });
  assert.deepEqual(forced.actions.map((a) => a.kind), ['remove-link', 'create-link']);
  applyPlan(forced);
  assert.deepEqual(fs.readdirSync(oldVault), ['x'], 'removing the link must not touch its target');
  const st = inspectDestination(path.join(project, '.claude', 'skills'));
  assert.equal(st.kind, 'link');
  assert.equal(path.resolve(st.resolvedTarget).toLowerCase(), path.resolve(newVault).toLowerCase());
});

test('ordinary directory: preserve merges only missing entries; force+no-preserve replaces', (t) => {
  const root = tempRoot(t);
  const vault = makeVault(root, 'vault', ['a', 'b']);
  const project = path.join(root, 'proj');
  const skills = path.join(project, '.claude', 'skills');
  fs.mkdirSync(path.join(skills, 'a'), { recursive: true });
  fs.writeFileSync(path.join(skills, 'a', 'SKILL.md'), 'LOCAL');

  const merge = planLink(project, vault, { preserve: true });
  assert.equal(merge.actions.length, 1);
  assert.equal(merge.actions[0].kind, 'copy-entries');
  assert.deepEqual(merge.actions[0].entries, ['b']);
  applyPlan(merge);
  assert.equal(fs.readFileSync(path.join(skills, 'a', 'SKILL.md'), 'utf8'), 'LOCAL', 'local skill kept');
  assert.ok(fs.existsSync(path.join(skills, 'b', 'SKILL.md')));

  const noForce = planLink(project, vault, { preserve: false });
  assert.equal(noForce.conflicts.length, 1);

  const replace = planLink(project, vault, { preserve: false, force: true });
  assert.deepEqual(replace.actions.map((a) => a.kind), ['remove-directory', 'create-link']);
  applyPlan(replace);
  assert.equal(inspectDestination(skills).kind, 'link');
});

test('link type none is non-mutating even with --force --no-preserve', (t) => {
  const root = tempRoot(t);
  const vault = makeVault(root, 'vault', ['a']);
  const project = path.join(root, 'proj');
  fs.mkdirSync(path.join(project, '.claude', 'skills', 'mine'), { recursive: true });
  const before = snapshot(root);
  const plan = planLink(project, vault, { linkType: 'none', preserve: false, force: true });
  assert.equal(plan.actions.length, 0);
  assert.equal(plan.conflicts.length, 0);
  applyPlan(plan);
  assert.deepEqual(snapshot(root), before);
});

test('a stale plan is refused: destination changed between plan and apply', (t) => {
  const root = tempRoot(t);
  const vault = makeVault(root, 'vault', ['a']);
  const project = path.join(root, 'proj');
  const plan = planLink(project, vault);
  fs.mkdirSync(path.join(project, '.claude', 'skills'), { recursive: true }); // appears after planning
  assert.throws(() => applyPlan(plan), { code: 'STALE_PLAN' });
});

test('remove-link refuses when the link now points elsewhere', (t) => {
  const root = tempRoot(t);
  const v1 = makeVault(root, 'v1', ['a']);
  const v2 = makeVault(root, 'v2', ['a']);
  const v3 = makeVault(root, 'v3', ['a']);
  const project = path.join(root, 'proj');
  fs.mkdirSync(path.join(project, '.claude'), { recursive: true });
  const link = path.join(project, '.claude', 'skills');
  mkLink(v1, link);
  const plan = planLink(project, v2, { force: true });
  fs.rmdirSync(link); mkLink(v3, link); // repointed behind our back
  assert.throws(() => applyPlan(plan), { code: 'STALE_PLAN' });
  assert.ok(fs.existsSync(path.join(v3, 'a')));
});

test('.gitignore gets only the generated skills link, never the doc or the dot-folder', (t) => {
  const root = tempRoot(t);
  const project = path.join(root, 'proj');
  fs.mkdirSync(project);
  fs.writeFileSync(path.join(project, '.gitignore'), 'node_modules');
  const plan = planGitignore(newPlan(claude, project), { projectRoot: project, target: claude });
  applyPlan(plan);
  const lines = fs.readFileSync(path.join(project, '.gitignore'), 'utf8').split('\n');
  assert.ok(lines.includes('.claude/skills'));
  assert.ok(!lines.includes('CLAUDE.md'));
  assert.ok(!lines.includes('.claude/'));
  assert.equal(planGitignore(newPlan(claude, project), { projectRoot: project, target: claude }).actions.length, 0, 'idempotent');
});

test('existing instruction doc is kept unless --force', (t) => {
  const root = tempRoot(t);
  const project = path.join(root, 'proj');
  fs.mkdirSync(project);
  fs.writeFileSync(path.join(project, 'CLAUDE.md'), 'hand edited');
  const tmplDir = path.join(root, 'templates');
  fs.mkdirSync(tmplDir);
  fs.writeFileSync(path.join(tmplDir, 'CLAUDE.md.tmpl'), '# ${PROJECT_NAME}');
  const keep = planDoc(newPlan(claude, project), { projectRoot: project, target: claude, templatesDir: tmplDir, vars: { PROJECT_NAME: 'p' }, force: false });
  assert.equal(keep.actions.length, 0);
  const over = planDoc(newPlan(claude, project), { projectRoot: project, target: claude, templatesDir: tmplDir, vars: { PROJECT_NAME: 'p' }, force: true });
  assert.equal(over.actions[0].content, '# p');
});
