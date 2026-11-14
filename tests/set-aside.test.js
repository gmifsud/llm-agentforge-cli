'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createPaths } = require('../src/infra/paths');
const { planSetAside, applySetAside, planRestore, applyRestore, listSetAside } = require('../src/application/set-aside');
const { tempRoot } = require('./helpers');
const { contentSnapshot } = require('./dashboard-fixtures');

function world(t) {
  const root = tempRoot(t);
  const homedir = path.join(root, 'home');
  const paths = createPaths({ homedir, scriptDir: root });
  const personal = path.join(homedir, '.claude', 'skills');
  fs.mkdirSync(path.join(personal, 'tdd', 'scripts'), { recursive: true });
  fs.writeFileSync(path.join(personal, 'tdd', 'SKILL.md'), '---\nname: tdd\ndescription: mine\n---\nmy own steps\r\n');
  fs.writeFileSync(path.join(personal, 'tdd', 'scripts', 'run.sh'), 'echo mine\n');
  fs.mkdirSync(path.join(personal, 'unrelated'), { recursive: true });
  fs.writeFileSync(path.join(personal, 'unrelated', 'SKILL.md'), '---\nname: unrelated\n---\n');
  return { root, homedir, paths, personal, library: ['tdd', 'diagnose'] };
}

test('set aside moves the personal folder whole, records where it came from, and touches nothing else', t => {
  const w = world(t);
  const before = contentSnapshot(path.join(w.personal, 'tdd'));
  const plan = planSetAside({ paths: w.paths, tool: 'claude', name: 'tdd', libraryNames: w.library });
  assert.equal(plan.ok, true, JSON.stringify(plan.conflicts));
  assert.equal(plan.from, path.join(w.personal, 'tdd'));
  assert.equal(plan.to, path.join(w.paths.setAsideDir, 'claude', 'tdd'));
  // Planning is read-only.
  assert.ok(fs.existsSync(plan.from));
  assert.equal(fs.existsSync(w.paths.setAsideDir), false);

  applySetAside(plan);
  assert.equal(fs.existsSync(path.join(w.personal, 'tdd')), false, 'the personal copy no longer hides the library skill');
  assert.deepEqual(contentSnapshot(plan.to), before, 'every file arrives byte for byte, line endings included');
  assert.ok(fs.existsSync(path.join(w.personal, 'unrelated', 'SKILL.md')), 'a neighbouring personal skill is untouched');
  assert.equal(fs.existsSync(path.join(plan.to, 'set-aside.json')), false, 'the moved folder gains no file');
  const rec = JSON.parse(fs.readFileSync(path.join(w.paths.setAsideDir, 'claude', 'tdd.json'), 'utf8'));
  assert.equal(rec.from, path.join(w.personal, 'tdd'));
  assert.equal(rec.tool, 'claude');
  assert.match(rec.at, /^\d{4}-\d{2}-\d{2}T/);
});

test('set aside refuses what it should: not a hiding skill, unknown tool, unsafe name, destination taken, missing folder', t => {
  const w = world(t);
  const conflicts = (args) => planSetAside({ paths: w.paths, libraryNames: w.library, ...args }).conflicts.join(' | ');
  assert.match(conflicts({ tool: 'claude', name: 'unrelated' }), /does not hide a library skill/);
  assert.match(conflicts({ tool: 'nope', name: 'tdd' }), /Unknown tool/);
  for (const name of ['../tdd', 'a/b', 'a\\b', '..', '.', '', 'x\0y']) assert.match(conflicts({ tool: 'claude', name }), /not a valid skill name/, JSON.stringify(name));
  assert.match(conflicts({ tool: 'claude', name: 'diagnose' }), /No personal claude skill called "diagnose"/);
  applySetAside(planSetAside({ paths: w.paths, tool: 'claude', name: 'tdd', libraryNames: w.library }));
  // A second personal copy appears and the first is still set aside: the earlier one is not overwritten.
  fs.mkdirSync(path.join(w.personal, 'tdd'));
  fs.writeFileSync(path.join(w.personal, 'tdd', 'SKILL.md'), 'again');
  assert.match(conflicts({ tool: 'claude', name: 'tdd' }), /already holds a set-aside tdd/);
});

test('apply refuses a plan that went stale and never overwrites', t => {
  const w = world(t);
  const plan = planSetAside({ paths: w.paths, tool: 'claude', name: 'tdd', libraryNames: w.library });
  fs.mkdirSync(plan.to, { recursive: true });
  assert.throws(() => applySetAside(plan), /appeared since planning/);
  assert.ok(fs.existsSync(path.join(w.personal, 'tdd', 'SKILL.md')), 'the personal copy stayed where it was');
  assert.equal(fs.existsSync(path.join(w.paths.setAsideDir, 'claude', 'tdd.json')), false, 'no record is left for a move that did not happen');
});

test('restore moves it back, refuses when something sits there now, and the list says what is set aside', t => {
  const w = world(t);
  const before = contentSnapshot(path.join(w.personal, 'tdd'));
  applySetAside(planSetAside({ paths: w.paths, tool: 'claude', name: 'tdd', libraryNames: w.library }));

  const listed = listSetAside(w.paths);
  assert.deepEqual(listed.map(x => [x.tool, x.name, x.restorable]), [['claude', 'tdd', true]]);
  assert.equal(listed[0].from, path.join(w.personal, 'tdd'));

  fs.mkdirSync(path.join(w.personal, 'tdd'));
  assert.match(planRestore({ paths: w.paths, tool: 'claude', name: 'tdd' }).conflicts.join(' '), /already a skill at/);
  assert.equal(listSetAside(w.paths)[0].restorable, false);
  fs.rmdirSync(path.join(w.personal, 'tdd'));

  const plan = planRestore({ paths: w.paths, tool: 'claude', name: 'tdd' });
  assert.equal(plan.ok, true, JSON.stringify(plan.conflicts));
  applyRestore(plan);
  assert.deepEqual(contentSnapshot(path.join(w.personal, 'tdd')), before, 'back exactly as it was');
  assert.deepEqual(listSetAside(w.paths), []);
  assert.equal(fs.existsSync(path.join(w.paths.setAsideDir, 'claude', 'tdd.json')), false, 'the record goes with the move');
});

test('a tampered record cannot send a restore somewhere else', t => {
  const w = world(t);
  applySetAside(planSetAside({ paths: w.paths, tool: 'claude', name: 'tdd', libraryNames: w.library }));
  const recFile = path.join(w.paths.setAsideDir, 'claude', 'tdd.json');
  const rec = JSON.parse(fs.readFileSync(recFile, 'utf8'));
  fs.writeFileSync(recFile, JSON.stringify({ ...rec, from: path.join(w.root, 'elsewhere', 'tdd') }));
  const plan = planRestore({ paths: w.paths, tool: 'claude', name: 'tdd' });
  assert.equal(plan.to, path.join(w.personal, 'tdd'), 'the destination comes from the tool and name, not from the file');
});
