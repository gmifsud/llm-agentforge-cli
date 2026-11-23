'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { syncView } = require('../src/application/sync');
const { createPaths } = require('../src/infra/paths');
const { digestSkill } = require('../src/discovery/skill-digest');
const { fixture } = require('./dashboard-fixtures');
const { mkLink, snapshot } = require('./helpers');

const REPO = path.resolve(__dirname, '..');
const NAME = 'frontend-design-lab';

/** The standard fixture: `frontend-design` is in the vault (the main copy) and in frontend-lab, which is kept here. */
function keptFixture(t, ruleOverrides = {}) {
  const f = fixture(t);
  const original = path.join(f.source, 'frontend-design');
  fs.writeFileSync(path.join(original, 'notes.txt'), 'extra file\n');
  const rule = { name: NAME, from: { skill: 'frontend-design', source: 'frontend-lab' }, description: 'The lab copy.', digest: digestSkill(original).digest, keptAt: 'now', ...ruleOverrides };
  fs.writeFileSync(path.join(f.homedir, '.agentforge', 'config.json'), JSON.stringify({ vaultRoot: f.vault, kept: [rule] }));
  const paths = createPaths({ homedir: f.homedir, scriptDir: REPO });
  const build = (extra = {}) => syncView({ paths, env: {}, fetch: false, git: {}, ...extra });
  return { ...f, original, paths, build, copy: path.join(paths.keptDir, NAME) };
}

test('a kept copy is a real folder with the new name and description; the rest is byte-identical and the library links to it', (t) => {
  const f = keptFixture(t);
  const result = f.build();
  assert.deepEqual(result.kept, { built: [NAME], droppedLinks: [], missing: [], blocked: [] });
  const skill = fs.readFileSync(path.join(f.copy, 'SKILL.md'), 'utf8');
  assert.match(skill, /^name: frontend-design-lab$/m);
  assert.match(skill, /The lab copy\./);
  assert.doesNotMatch(skill, /frontend-design from source/);
  assert.ok(skill.endsWith('# frontend-design\n'), 'the body is untouched');
  assert.equal(fs.readFileSync(path.join(f.copy, 'notes.txt'), 'utf8'), 'extra file\n');
  assert.equal(fs.lstatSync(f.copy).isSymbolicLink(), false, 'a real folder, not a link');
  assert.equal(fs.realpathSync(path.join(f.paths.mergedSkills, NAME)), fs.realpathSync(f.copy));
  assert.ok(fs.existsSync(path.join(f.paths.keptDir, '.agentforge-kept')));
});

test('every build regenerates the copy from the original as it is now', (t) => {
  const f = keptFixture(t);
  f.build();
  fs.writeFileSync(path.join(f.original, 'notes.txt'), 'changed\n');
  const second = f.build();
  assert.equal(fs.readFileSync(path.join(f.copy, 'notes.txt'), 'utf8'), 'changed\n');
  assert.deepEqual(second.kept.built, [NAME]);
  assert.deepEqual(fs.readdirSync(f.paths.agentforgeDir).filter((n) => /staging|old-/.test(n)), [], 'no staging or backup left behind');
});

test('a link leading outside the original is not copied and is reported; one that stays inside is kept as a link', (t) => {
  const f = keptFixture(t);
  const outside = path.join(f.root, 'elsewhere'); fs.mkdirSync(outside);
  fs.writeFileSync(path.join(outside, 'secret.txt'), 'private');
  mkLink(outside, path.join(f.original, 'escape'));
  fs.mkdirSync(path.join(f.original, 'inner'));
  mkLink(path.join(f.original, 'inner'), path.join(f.original, 'inner-alias'));
  const result = f.build();
  assert.deepEqual(result.kept.droppedLinks, [{ name: NAME, path: 'escape' }]);
  assert.equal(fs.existsSync(path.join(f.copy, 'escape')), false);
  assert.equal(fs.lstatSync(path.join(f.copy, 'inner-alias')).isSymbolicLink(), true);
  assert.ok(fs.existsSync(path.join(outside, 'secret.txt')), 'the target of a dropped link is never touched');
});

test('something in kept/ that agentforge did not make is refused, and the live folder is left as it was', (t) => {
  const f = keptFixture(t);
  f.build();
  fs.writeFileSync(path.join(f.paths.keptDir, 'mine.txt'), 'user file');
  const before = snapshot(f.paths.keptDir);
  const viewBefore = snapshot(f.paths.mergedSkills);
  assert.throws(() => f.build(), (e) => e.code === 'KEPT_SHAPE');
  assert.deepEqual(snapshot(f.paths.keptDir), before);
  assert.deepEqual(snapshot(f.paths.mergedSkills), viewBefore);
});

test('a kept/ with no marker is refused unless it is empty', (t) => {
  const f = keptFixture(t);
  fs.mkdirSync(path.join(f.paths.keptDir, 'stray'), { recursive: true });
  assert.throws(() => f.build(), (e) => e.code === 'KEPT_SHAPE');
  fs.rmdirSync(path.join(f.paths.keptDir, 'stray'));
  assert.deepEqual(f.build().kept.built, [NAME]);
});

test('a dry run writes nothing but says what would be built', (t) => {
  const f = keptFixture(t);
  const before = snapshot(f.homedir);
  const result = f.build({ dryRun: true });
  assert.deepEqual(result.kept.built, [NAME]);
  assert.deepEqual(snapshot(f.homedir), before);
  assert.equal(fs.existsSync(f.paths.keptDir), false);
});

test('a rule whose original is gone leaves the config alone, builds the rest, and is reported as missing', (t) => {
  const f = keptFixture(t);
  fs.rmSync(f.original, { recursive: true, force: true });
  const configBefore = fs.readFileSync(f.paths.configJson, 'utf8');
  const result = f.build();
  assert.deepEqual(result.kept, { built: [], droppedLinks: [], missing: [NAME], blocked: [] });
  assert.equal(fs.readFileSync(f.paths.configJson, 'utf8'), configBefore);
  assert.deepEqual(fs.readdirSync(f.paths.keptDir), ['.agentforge-kept'], 'an empty marked folder');
  assert.equal(fs.existsSync(path.join(f.paths.mergedSkills, NAME)), false);
});

test('a rule that cannot be built is reported as blocked with its reason, and the build still succeeds', (t) => {
  const main = keptFixture(t, { name: 'frontend-design-main', from: { skill: 'frontend-design', source: 'vault' } });
  assert.deepEqual(main.build().kept.blocked, [{ name: 'frontend-design-main', reason: 'is-main' }]);

  const taken = keptFixture(t);
  fs.mkdirSync(path.join(taken.vault, NAME));
  fs.writeFileSync(path.join(taken.vault, NAME, 'SKILL.md'), `---
name: ${NAME}
description: a real skill
---
`);
  const result = taken.build();
  assert.deepEqual(result.kept, { built: [], droppedLinks: [], missing: [], blocked: [{ name: NAME, reason: 'taken' }] });
  assert.ok(fs.existsSync(path.join(taken.paths.mergedSkills, NAME)), 'the other skill keeps the name');
});
