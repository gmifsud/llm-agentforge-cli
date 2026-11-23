'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createPaths, loadConfig } = require('../src/infra/paths');
const { validateKept, checkKeptName, distinctOthers } = require('../src/domain/kept');
const { tempRoot } = require('./helpers');

const rule = (over = {}) => ({
  name: 'brainstorming-x',
  from: { skill: 'brainstorming', source: 'repoB' },
  description: 'A kept copy.',
  digest: 'd1',
  keptAt: '2026-11-22T00:00:00.000Z',
  ...over,
});
const invalid = (kept) => assert.throws(() => validateKept(kept, 'config.json'), (e) => e.code === 'CONFIG_INVALID');

test('validateKept accepts an empty list and a well-formed rule, including a null digest', () => {
  validateKept([], 'config.json');
  validateKept([rule()], 'config.json');
  validateKept([rule({ digest: null })], 'config.json');
});

test('validateKept rejects malformed rules', () => {
  invalid('nope');
  invalid({});
  invalid([null]);
  invalid([rule({ from: { skill: 'brainstorming' } })]);
  invalid([rule({ from: null })]);
  invalid([rule({ name: 'Bad_Name' })]);
  invalid([rule({ digest: 5 })]);
  invalid([rule({ keptAt: undefined })]);
  invalid([rule(), rule()]);
  invalid([rule({ description: 'one\ntwo' })]);
});

test('loadConfig rejects an invalid kept section and accepts a valid one', (t) => {
  const root = tempRoot(t);
  const paths = createPaths({ homedir: root, scriptDir: root });
  fs.mkdirSync(paths.agentforgeDir, { recursive: true });
  assert.equal(paths.keptDir, path.join(paths.agentforgeDir, 'kept'));
  fs.writeFileSync(paths.configJson, JSON.stringify({ kept: 5 }));
  assert.throws(() => loadConfig(paths), (e) => e.code === 'CONFIG_INVALID');
  fs.writeFileSync(paths.configJson, JSON.stringify({ kept: [rule()] }));
  assert.equal(loadConfig(paths).kept.length, 1);
  fs.writeFileSync(paths.configJson, JSON.stringify({}));
  assert.deepEqual(loadConfig(paths), {});
});

test('checkKeptName', () => {
  assert.equal(checkKeptName('brainstorming-x', 'brainstorming', new Set()), null);
  assert.ok(checkKeptName('other-x', 'brainstorming', new Set()));
  assert.ok(checkKeptName('brainstorming', 'brainstorming', new Set()));
  assert.ok(checkKeptName('Brainstorming-x', 'brainstorming', new Set()));
  assert.ok(checkKeptName('brainstorming-' + 'x'.repeat(51), 'brainstorming', new Set()));
  assert.equal(checkKeptName('brainstorming-' + 'x'.repeat(50), 'brainstorming', new Set()), null);
  assert.ok(checkKeptName('brainstorming-x', 'brainstorming', new Set(['brainstorming-x'])));
});

test('distinctOthers groups identical content under the highest-ranked holder and drops the winning content', () => {
  const candidates = [
    { source: 'vault', digest: 'd1', winner: true },
    { source: 'D', digest: 'd1', winner: false },
    { source: 'C', digest: 'd2', winner: false },
    { source: 'B', digest: 'd2', winner: false },
  ];
  assert.deepEqual(distinctOthers(candidates, ['vault', 'B', 'C', 'D']), [{ source: 'B', also: ['C'], digest: 'd2' }]);
});

test('distinctOthers never treats a null digest as equal to anything', () => {
  const candidates = [
    { source: 'vault', digest: null, winner: true },
    { source: 'B', digest: null, winner: false },
    { source: 'C', digest: null, winner: false },
  ];
  assert.deepEqual(distinctOthers(candidates, ['vault', 'B', 'C']), [
    { source: 'B', also: [], digest: null },
    { source: 'C', also: [], digest: null },
  ]);
});

test('an upper-case plain name can be kept: the prefix is its lower-case form', () => {
  assert.equal(checkKeptName('brainstorming-x', 'Brainstorming', new Set()), null);
  assert.match(checkKeptName('other-x', 'Brainstorming', new Set()), /must start with "brainstorming-"/);
  validateKept([rule({ from: { skill: 'Brainstorming', source: 'repoB' } })], 'config.json');
});
