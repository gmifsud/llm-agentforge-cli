'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { digestSkill } = require('../src/discovery/skill-digest');
const { tempRoot, mkLink } = require('./helpers');

function skill(root, name, files) {
  const dir = path.join(root, name);
  for (const [rel, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), content);
  }
  return dir;
}

test('the digest ignores the folder name and where the skill lives', (t) => {
  const root = tempRoot(t);
  const a = skill(root, 'vault/tdd', { 'SKILL.md': '---\nname: tdd\n---\nbody\n', 'scripts/run.sh': 'echo hi\n' });
  const b = skill(root, 'other/tdd-copy', { 'scripts/run.sh': 'echo hi\n', 'SKILL.md': '---\nname: tdd\n---\nbody\n' });
  assert.equal(digestSkill(a).digest, digestSkill(b).digest);
  assert.match(digestSkill(a).digest, /^[a-f0-9]{64}$/);
  assert.deepEqual(digestSkill(a).files.map((f) => f.path), ['SKILL.md', 'scripts/run.sh']);
});

test('line endings and a byte-order mark do not change the digest of text files', (t) => {
  const root = tempRoot(t);
  const lf = skill(root, 'lf', { 'SKILL.md': '# a\nline two\n' });
  const crlf = skill(root, 'crlf', { 'SKILL.md': '# a\r\nline two\r\n' });
  const bom = skill(root, 'bom', { 'SKILL.md': '﻿# a\nline two\n' });
  assert.equal(digestSkill(lf).digest, digestSkill(crlf).digest);
  assert.equal(digestSkill(lf).digest, digestSkill(bom).digest);
});

test('any real difference changes it: an edit, an extra file, a renamed file', (t) => {
  const root = tempRoot(t);
  const base = digestSkill(skill(root, 'base', { 'SKILL.md': 'one\n', 'ref.md': 'r\n' })).digest;
  assert.notEqual(digestSkill(skill(root, 'edit', { 'SKILL.md': 'one.\n', 'ref.md': 'r\n' })).digest, base);
  assert.notEqual(digestSkill(skill(root, 'extra', { 'SKILL.md': 'one\n', 'ref.md': 'r\n', 'x.md': '' })).digest, base);
  assert.notEqual(digestSkill(skill(root, 'renamed', { 'SKILL.md': 'one\n', 'reference.md': 'r\n' })).digest, base);
});

test('binary files are hashed byte for byte; CRLF inside them is not normalised', (t) => {
  const root = tempRoot(t);
  const a = skill(root, 'a', { 'SKILL.md': 'x\n', 'img.bin': Buffer.from([0, 13, 10, 1]) });
  const b = skill(root, 'b', { 'SKILL.md': 'x\n', 'img.bin': Buffer.from([0, 10, 1]) });
  assert.notEqual(digestSkill(a).digest, digestSkill(b).digest);
});

test('links inside a skill are recorded but never followed; junk folders are skipped', (t) => {
  const root = tempRoot(t);
  const outside = skill(root, 'outside', { 'secret.md': 'do not read' });
  const a = skill(root, 'a', { 'SKILL.md': 'x\n', '.git/HEAD': 'ref', 'node_modules/p/i.js': '1', '__pycache__/c.pyc': '1' });
  const plain = digestSkill(skill(root, 'plain', { 'SKILL.md': 'x\n' }));
  assert.equal(digestSkill(a).digest, plain.digest, '.git, node_modules and __pycache__ do not count');
  mkLink(outside, path.join(a, 'linked'));
  const withLink = digestSkill(a);
  assert.notEqual(withLink.digest, plain.digest, 'the presence of a link is part of the identity');
  assert.ok(withLink.files.some((f) => f.path === 'linked' && f.link));
  assert.ok(!withLink.files.some((f) => f.path.startsWith('linked/')));
});

test('limits are enforced so a huge or runaway folder cannot stall the dashboard', (t) => {
  const root = tempRoot(t);
  const many = skill(root, 'many', Object.fromEntries(Array.from({ length: 12 }, (_, i) => [`f${i}.md`, 'x'])));
  assert.throws(() => digestSkill(many, { maxFiles: 10 }), { code: 'DIGEST_LIMIT' });
  const big = skill(root, 'big', { 'SKILL.md': 'x'.repeat(2048) });
  assert.throws(() => digestSkill(big, { maxBytes: 1024 }), { code: 'DIGEST_LIMIT' });
});
