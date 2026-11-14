'use strict';
/**
 * T31 step 2: what the catalogue tells the page so it can offer Set aside, Restore and Adopt.
 *   health.shadows[]  each gains the library path and how the two copies differ
 *   setAside[]        what is set aside now, and whether it can go back
 *   targets[].adoptable  for a skills folder of the owner's own that nothing here manages
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { ReadService } = require('../dashboard/server/read-service');
const { WriteService } = require('../dashboard/server/write-service');
const { fixture } = require('./dashboard-fixtures');

const lower = (p) => p.toLowerCase();
const apply = (svc, ...changes) => svc.apply(changes).results.map(r => r.status);
const writeSkill = (dir, description, extra = {}) => {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'SKILL.md'), `---\nname: ${path.basename(dir)}\ndescription: ${description}\n---\nsteps\n`);
  for (const [file, text] of Object.entries(extra)) fs.writeFileSync(path.join(dir, file), text);
};

// The fixture library: frontend-design and sql-review from the vault, browser-testing from the source.
test('a hidden skill shows both paths and how the two copies differ', t => {
  const f = fixture(t);
  const personal = path.join(f.homedir, '.claude', 'skills');
  writeSkill(path.join(personal, 'browser-testing'), 'my own take', { 'extra.md': 'only mine\n' });
  fs.cpSync(path.join(f.vault, 'sql-review'), path.join(personal, 'sql-review'), { recursive: true });

  const shadows = new ReadService(f.options).refresh().health.shadows;
  const different = shadows.find(s => s.name === 'browser-testing');
  assert.equal(different.path, path.join(personal, 'browser-testing'));
  assert.equal(lower(different.libraryPath), lower(path.join(f.source, 'browser-testing')), 'the folder the library takes it from');
  assert.equal(different.same, false);
  assert.equal(different.personalDescription, 'my own take');
  assert.equal(typeof different.libraryDescription, 'string');
  assert.notEqual(different.libraryDescription, different.personalDescription);
  assert.equal(different.personalFiles, different.libraryFiles + 1, 'the extra file is counted');

  assert.equal(shadows.find(s => s.name === 'sql-review').same, true, 'a byte-identical copy is said to be the same');
});

test('the catalogue lists what is set aside, whether it can go back, and the hiding stops', t => {
  const f = fixture(t);
  writeSkill(path.join(f.homedir, '.claude', 'skills', 'browser-testing'), 'mine');
  const svc = new WriteService(f.options);
  assert.deepEqual(new ReadService(f.options).refresh().setAside, [], 'nothing set aside yet');

  assert.deepEqual(apply(svc, { kind: 'skill.setaside', args: { tool: 'claude', name: 'browser-testing' } }), ['applied']);
  const c = new ReadService(f.options).refresh();
  assert.deepEqual(c.setAside.map(x => [x.tool, x.name, x.restorable]), [['claude', 'browser-testing', true]]);
  assert.match(c.setAside[0].at, /^\d{4}-\d\d-\d\dT/);
  assert.equal(c.setAside[0].from, path.join(f.homedir, '.claude', 'skills', 'browser-testing'), 'where it goes back to');
  assert.deepEqual(c.health.shadows.map(s => s.name), [], 'the library skill is no longer hidden');

  writeSkill(path.join(f.homedir, '.claude', 'skills', 'browser-testing'), 'a new personal one');
  assert.equal(new ReadService(f.options).refresh().setAside[0].restorable, false, 'something sits there now');
});

test('a skills folder of your own that nothing here manages is reported as adoptable, with what stays yours', t => {
  const f = fixture(t);
  const project = path.join(f.root, 'unmanaged');
  const folder = path.join(project, '.claude', 'skills');
  writeSkill(path.join(folder, 'mine'), 'only here');
  writeSkill(path.join(folder, 'frontend-design'), 'my version');
  fs.writeFileSync(path.join(folder, 'notes.txt'), 'not a skill\n');
  const options = { ...f.options, projects: [f.project, project] };
  const svc = new WriteService(options);
  apply(svc, { kind: 'library.rebuild' });

  const claudeOf = (c, p) => c.projects.find(x => x.project.path === p).targets.find(x => x.id === 'claude');
  let c = new ReadService(options).refresh();
  assert.equal(claudeOf(c, f.project).adoptable, null, 'a folder that is a link to the library is already managed');
  assert.deepEqual(claudeOf(c, project).adoptable, { own: ['mine'], shared: ['frontend-design'], incoming: 2, others: 1 });
  assert.equal(claudeOf(c, project).feeds, 'copy');

  const id = svc.projects().find(p => p.path === project).id;
  assert.deepEqual(apply(svc, { kind: 'project.adopt', args: { projectId: id, target: 'claude' } }), ['applied']);
  c = new ReadService(options).refresh();
  assert.equal(claudeOf(c, project).adoptable, null, 'once adopted it is managed, so Refresh copy applies instead');
  assert.ok(claudeOf(c, project).copy, 'and it reads as a managed copy');
});
