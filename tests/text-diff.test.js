'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { diffLines } = require('../src/discovery/text-diff');

const shape = (d) => d.hunks.map((h) => (h.type === 'skip' ? `…${h.count}` : `${{ same: ' ', add: '+', del: '-' }[h.type]}${h.text}`));

test('identical texts have no changes; line endings do not count', () => {
  const d = diffLines('a\nb\nc', 'a\r\nb\r\nc');
  assert.deepEqual({ added: d.added, removed: d.removed, tooLarge: d.tooLarge }, { added: 0, removed: 0, tooLarge: false });
  assert.ok(d.hunks.every((h) => h.type === 'same' || h.type === 'skip'));
});

test('a changed line is one removal and one addition, with line numbers on each side', () => {
  const d = diffLines('one\ntwo\nthree', 'one\nTWO\nthree');
  assert.deepEqual(shape(d), [' one', '-two', '+TWO', ' three']);
  assert.deepEqual(d.hunks.find((h) => h.type === 'del'), { type: 'del', text: 'two', a: 2 });
  assert.deepEqual(d.hunks.find((h) => h.type === 'add'), { type: 'add', text: 'TWO', b: 2 });
  assert.deepEqual({ added: d.added, removed: d.removed }, { added: 1, removed: 1 });
});

test('insertions and deletions in the middle keep the rest aligned', () => {
  assert.deepEqual(shape(diffLines('a\nb\nc\nd', 'a\nc\nd')), [' a', '-b', ' c', ' d']);
  assert.deepEqual(shape(diffLines('a\nc\nd', 'a\nb\nc\nd')), [' a', '+b', ' c', ' d']);
  assert.deepEqual(shape(diffLines('', 'x\ny')), ['-', '+x', '+y']);
});

test('long unchanged runs collapse, keeping context beside each change', () => {
  const lines = Array.from({ length: 30 }, (_, i) => `line ${i + 1}`);
  const changed = [...lines]; changed[14] = 'CHANGED';
  const d = diffLines(lines.join('\n'), changed.join('\n'), { context: 2 });
  assert.deepEqual(shape(d), ['…12', ' line 13', ' line 14', '-line 15', '+CHANGED', ' line 16', ' line 17', '…13']);
});

test('a comparison too large to compute says so instead of stalling', () => {
  const a = Array.from({ length: 300 }, (_, i) => `a${i}`).join('\n');
  const b = Array.from({ length: 300 }, (_, i) => `b${i}`).join('\n');
  const d = diffLines(a, b, { maxCells: 1000 });
  assert.deepEqual(d, { tooLarge: true, added: 0, removed: 0, hunks: [] });
  // A shared start and end are trimmed first, so one change in a big file is still cheap.
  const big = Array.from({ length: 5000 }, (_, i) => `l${i}`);
  const big2 = [...big]; big2[2500] = 'x';
  assert.equal(diffLines(big.join('\n'), big2.join('\n'), { maxCells: 1000 }).tooLarge, false);
});
