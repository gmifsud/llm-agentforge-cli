'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { parseFrontmatter, lintSkill, findShadows } = require('../src/discovery/skill-lint');
const { estimateListing } = require('../src/discovery/listing-budget');
const { tempRoot } = require('./helpers');

function skill(root, folder, text) {
  const dir = path.join(root, folder);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'SKILL.md'), text);
  return dir;
}
const codes = (dir) => lintSkill(dir).findings.map((f) => f.code).sort();

test('frontmatter: plain, quoted and block values; must open on line 1', () => {
  const fm = parseFrontmatter('---\nname: tdd\ndescription: "Red, green: refactor"\nuser-invocable: false\nlong: >\n  folded\n  text\nlit: |\n  a\n  b\n---\n# body\n');
  assert.deepEqual(fm.fields, { name: 'tdd', description: 'Red, green: refactor', 'user-invocable': 'false', long: 'folded text', lit: 'a\nb' });
  assert.equal(fm.body.trim(), '# body');
  assert.equal(parseFrontmatter('\n---\nname: x\n---\n').fields, null, 'a blank first line means no frontmatter');
  assert.equal(parseFrontmatter('# just a heading\n').fields, null);
  assert.equal(parseFrontmatter('---\r\nname: x\r\n---\r\nbody').fields.name, 'x', 'CRLF files parse');
});

test('a well-formed skill has no findings', (t) => {
  const root = tempRoot(t);
  assert.deepEqual(codes(skill(root, 'tdd', '---\nname: tdd\ndescription: Test first.\n---\nbody')), []);
});

test('each problem is reported with the tools it breaks in', (t) => {
  const root = tempRoot(t);
  assert.deepEqual(codes(skill(root, 'a', '# no frontmatter\n')), ['NO_FRONTMATTER']);
  assert.deepEqual(codes(skill(root, 'b', '---\ndescription: d\n---\n')), ['NAME_MISSING']);
  assert.deepEqual(codes(skill(root, 'c', '---\nname: c\n---\n')), ['DESCRIPTION_MISSING']);
  assert.deepEqual(codes(skill(root, 'folder-x', '---\nname: other\ndescription: d\n---\n')), ['NAME_MISMATCH']);
  assert.deepEqual(codes(skill(root, 'Bad_Name', '---\nname: Bad_Name\ndescription: d\n---\n')), ['NAME_CHARSET']);
  assert.deepEqual(codes(skill(root, 'long', `---\nname: long\ndescription: ${'x'.repeat(1600)}\n---\n`)), ['DESCRIPTION_LONG']);
  assert.deepEqual(codes(skill(root, 'hidden', '---\nname: hidden\ndescription: d\nuser-invocable: false\n---\n')), ['NOT_USER_INVOCABLE']);
  assert.deepEqual(codes(skill(root, 'manual', '---\nname: manual\ndescription: d\ndisable-model-invocation: true\n---\n')), ['MODEL_INVOCATION_OFF']);

  const mismatch = lintSkill(path.join(root, 'folder-x')).findings[0];
  assert.equal(mismatch.severity, 'error');
  assert.ok(mismatch.tools.includes('cursor'), 'Cursor requires name to equal the folder');
  assert.ok(!mismatch.tools.includes('claude'), 'Claude Code does not');
  assert.match(mismatch.message, /other.*folder-x/);
  const missing = lintSkill(path.join(root, 'nope'));
  assert.deepEqual(missing.findings.map((f) => f.code), ['NO_SKILL_MD']);
});

test('shadowing: a same-name skill at the personal level hides the linked one', (t) => {
  const root = tempRoot(t);
  const personal = path.join(root, 'home', '.claude', 'skills');
  skill(personal, 'tdd', '---\nname: tdd\ndescription: mine\n---\n');
  fs.mkdirSync(path.join(personal, '.trash'), { recursive: true });
  fs.mkdirSync(path.join(personal, 'not-a-skill'), { recursive: true });
  const shadows = findShadows(['tdd', 'diagnose', 'TDD-other'], [{ tool: 'claude', level: 'personal', dir: personal }, { tool: 'gemini', level: 'personal', dir: path.join(root, 'missing') }]);
  assert.deepEqual(shadows, [{ name: 'tdd', tool: 'claude', level: 'personal', path: path.join(personal, 'tdd') }]);
});

test('listing budget: names always fit; counts how many descriptions cannot', () => {
  const skills = Array.from({ length: 10 }, (_, i) => ({ name: `s${i}`, description: 'd'.repeat(100) }));
  const fits = estimateListing(skills, { budgetChars: 2000 });
  assert.deepEqual({ total: fits.descriptionChars, dropped: fits.dropped, fits: fits.fits }, { total: 1000, dropped: 0, fits: true });
  const tight = estimateListing(skills, { budgetChars: 350 });
  assert.equal(tight.fits, false);
  assert.equal(tight.dropped, 7, 'three 100-character descriptions fit in 350');
  assert.equal(tight.entries, 10);
  // Best case is assumed (shortest first), so "dropped" is a floor, never an overstatement.
  const mixed = estimateListing([{ name: 'a', description: 'x'.repeat(300) }, { name: 'b', description: 'y'.repeat(10) }, { name: 'c', description: '' }], { budgetChars: 50 });
  assert.equal(mixed.dropped, 1);
  assert.equal(mixed.withoutDescription, 1);
  // Per-entry cap: an over-long description only counts up to the cap.
  assert.equal(estimateListing([{ name: 'a', description: 'x'.repeat(5000) }], { budgetChars: 99999, perEntryCap: 1536 }).descriptionChars, 1536);
  // Budget from a context window: 1% of tokens, about four characters per token.
  assert.equal(estimateListing([], { contextTokens: 200000 }).budgetChars, 8000);
  assert.equal(estimateListing([], { contextTokens: 1000000 }).budgetChars, 40000);
});
