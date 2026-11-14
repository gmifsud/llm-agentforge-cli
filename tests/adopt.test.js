'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { TARGETS } = require('../src/domain/targets');
const { planAdopt } = require('../src/application/adopt');
const { applyPlan } = require('../src/deployment/apply');
const { newPlan, planSkillsLink } = require('../src/deployment/plan');
const { copyState, readMarker } = require('../src/deployment/copy-state');
const { tempRoot, makeVault, mkLink } = require('./helpers');
const { contentSnapshot } = require('./dashboard-fixtures');

function world(t) {
  const root = tempRoot(t);
  const library = makeVault(root, 'library', ['tdd', 'diagnose', 'review']);
  const project = path.join(root, 'project');
  const folder = path.join(project, '.claude', 'skills');
  fs.mkdirSync(path.join(folder, 'mine'), { recursive: true });
  fs.writeFileSync(path.join(folder, 'mine', 'SKILL.md'), '---\nname: mine\n---\nonly here\r\n');
  fs.mkdirSync(path.join(folder, 'tdd'));
  fs.writeFileSync(path.join(folder, 'tdd', 'SKILL.md'), '---\nname: tdd\n---\nmy version of tdd\n');
  fs.writeFileSync(path.join(folder, 'notes.txt'), 'not a skill\n');
  fs.writeFileSync(path.join(project, '.gitignore'), 'node_modules\n');
  return { root, library, project, folder, target: TARGETS.claude };
}
const plan = w => planAdopt({ projectRoot: w.project, target: w.target, libraryRoot: w.library });

test('adopt lists what is yours, what the library shares, and what would be added; planning writes nothing', t => {
  const w = world(t);
  const before = contentSnapshot(w.project);
  const p = plan(w);
  assert.equal(p.ok, true, JSON.stringify(p.conflicts));
  assert.deepEqual(p.own, ['mine'], 'skills that are not in the library are listed');
  assert.deepEqual(p.shared, ['tdd'], 'same name as a library skill: yours stays, the library one is not copied');
  assert.deepEqual(p.incoming, ['diagnose', 'review']);
  assert.equal(p.others, 1, 'a file that is not a skill is counted and kept');
  assert.deepEqual(contentSnapshot(w.project), before);
});

test('adopt keeps every file you own byte for byte, records only what it added, and ignores only its own marker', t => {
  const w = world(t);
  const mineBefore = contentSnapshot(path.join(w.folder, 'mine'));
  const tddBefore = contentSnapshot(path.join(w.folder, 'tdd'));
  const p = plan(w);
  const res = applyPlan({ target: 'claude', actions: p.actions, conflicts: p.conflicts, notes: p.notes });
  assert.ok(res.applied.length >= 1);

  assert.deepEqual(contentSnapshot(path.join(w.folder, 'mine')), mineBefore);
  assert.deepEqual(contentSnapshot(path.join(w.folder, 'tdd')), tddBefore, 'your own tdd was not replaced');
  assert.equal(fs.readFileSync(path.join(w.folder, 'notes.txt'), 'utf8'), 'not a skill\n');
  assert.deepEqual(fs.readdirSync(w.folder).sort(), ['diagnose', 'mine', 'notes.txt', 'review', 'tdd']);

  const marker = readMarker(path.join(w.project, '.claude'));
  assert.deepEqual(marker.names, ['diagnose', 'review'], 'the record names what Agentforge added and nothing of yours');
  assert.equal(copyState(path.join(w.project, '.claude'), w.library).state, 'fresh');

  const ignore = fs.readFileSync(path.join(w.project, '.gitignore'), 'utf8');
  assert.match(ignore, /\.claude\/\.agentforge-skills\.json/);
  assert.doesNotMatch(ignore, /\.claude\/skills/, 'your own committed skills are never hidden from git');
});

test('after adopting, a library change makes the copy stale and a refresh adds to it without touching yours', t => {
  const w = world(t);
  const p = plan(w);
  applyPlan({ target: 'claude', actions: p.actions, conflicts: [], notes: [] });
  fs.mkdirSync(path.join(w.library, 'fresh-skill'));
  fs.writeFileSync(path.join(w.library, 'fresh-skill', 'SKILL.md'), '---\nname: fresh-skill\n---\n');
  assert.equal(copyState(path.join(w.project, '.claude'), w.library).state, 'stale');

  const mineBefore = contentSnapshot(path.join(w.folder, 'mine'));
  const tddBefore = contentSnapshot(path.join(w.folder, 'tdd'));
  const refresh = newPlan(w.target, w.project);
  planSkillsLink(refresh, { projectRoot: w.project, target: w.target, vaultRoot: w.library, copy: true });
  assert.equal(refresh.actions[0].kind, 'refresh-copy');
  applyPlan(refresh);
  assert.deepEqual(contentSnapshot(path.join(w.folder, 'mine')), mineBefore);
  assert.deepEqual(contentSnapshot(path.join(w.folder, 'tdd')), tddBefore);
  assert.ok(fs.existsSync(path.join(w.folder, 'fresh-skill', 'SKILL.md')));
  assert.equal(copyState(path.join(w.project, '.claude'), w.library).state, 'fresh');
});

test('a name that appears between the preview and Apply is yours: it is not copied over and not recorded as ours', t => {
  const w = world(t);
  const p = plan(w);
  fs.mkdirSync(path.join(w.folder, 'review'));
  fs.writeFileSync(path.join(w.folder, 'review', 'SKILL.md'), 'arrived late and is mine');
  applyPlan({ target: 'claude', actions: p.actions, conflicts: [], notes: [] });
  assert.equal(fs.readFileSync(path.join(w.folder, 'review', 'SKILL.md'), 'utf8'), 'arrived late and is mine');
  assert.deepEqual(readMarker(path.join(w.project, '.claude')).names, ['diagnose'], 'a later refresh can never remove it');
});

test('adopt refuses a folder that is not an ordinary directory or is already managed, and a library that is not there', t => {
  const w = world(t);
  const conflicts = (over = {}) => planAdopt({ projectRoot: w.project, target: w.target, libraryRoot: w.library, ...over }).conflicts.join(' | ');
  assert.match(conflicts({ libraryRoot: path.join(w.root, 'nope') }), /library/i);
  assert.match(conflicts({ projectRoot: path.join(w.root, 'elsewhere') }), /no skills folder/i);

  const linked = path.join(w.root, 'linked'); fs.mkdirSync(path.join(linked, '.claude'), { recursive: true });
  mkLink(w.library, path.join(linked, '.claude', 'skills'));
  assert.match(conflicts({ projectRoot: linked }), /not an ordinary folder/);

  const p = plan(w); applyPlan({ target: 'claude', actions: p.actions, conflicts: [], notes: [] });
  assert.match(conflicts(), /already managed/i);
});
