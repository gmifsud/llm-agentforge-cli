'use strict';

/**
 * Line diff for comparing two versions of a skill's instructions.
 * Pure and bounded: above `maxCells` (lines of A × lines of B after trimming the
 * common start and end) it reports tooLarge instead of working on it.
 *
 * Returns { tooLarge, added, removed, hunks } where each hunk is
 *   { type: 'same' | 'del' | 'add', text, a?, b? }   a/b are 1-based line numbers
 *   { type: 'skip', count }                            a collapsed run of unchanged lines
 */
function diffLines(textA, textB, { maxCells = 4_000_000, context = 3 } = {}) {
  const a = String(textA).replace(/\r\n?/g, '\n').split('\n');
  const b = String(textB).replace(/\r\n?/g, '\n').split('\n');

  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let endA = a.length, endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) { endA--; endB--; }

  const n = endA - start, m = endB - start;
  if (n * m > maxCells) return { tooLarge: true, added: 0, removed: 0, hunks: [] };

  // Longest common subsequence over the differing middle.
  const width = m + 1;
  const table = new Uint32Array((n + 1) * width);
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      table[i * width + j] = a[start + i] === b[start + j]
        ? table[(i + 1) * width + j + 1] + 1
        : Math.max(table[(i + 1) * width + j], table[i * width + j + 1]);
    }
  }

  const raw = [];
  for (let k = 0; k < start; k++) raw.push({ type: 'same', text: a[k], a: k + 1, b: k + 1 });
  let i = 0, j = 0, added = 0, removed = 0;
  while (i < n || j < m) {
    if (i < n && j < m && a[start + i] === b[start + j]) { raw.push({ type: 'same', text: a[start + i], a: start + i + 1, b: start + j + 1 }); i++; j++; }
    // On a tie, the removed line comes first, as readers expect.
    else if (i < n && (j === m || table[(i + 1) * width + j] >= table[i * width + j + 1])) { raw.push({ type: 'del', text: a[start + i], a: start + i + 1 }); i++; removed++; }
    else { raw.push({ type: 'add', text: b[start + j], b: start + j + 1 }); j++; added++; }
  }
  for (let k = 0; endA + k < a.length; k++) raw.push({ type: 'same', text: a[endA + k], a: endA + k + 1, b: endB + k + 1 });

  // Collapse long unchanged runs, keeping `context` lines next to each change.
  const hunks = [];
  for (let k = 0; k < raw.length;) {
    if (raw[k].type !== 'same') { hunks.push(raw[k++]); continue; }
    let end = k;
    while (end < raw.length && raw[end].type === 'same') end++;
    const run = raw.slice(k, end);
    const head = k === 0 ? 0 : context;
    const tail = end === raw.length ? 0 : context;
    if (run.length > head + tail + 1) {
      hunks.push(...run.slice(0, head), { type: 'skip', count: run.length - head - tail }, ...run.slice(run.length - tail || run.length));
    } else hunks.push(...run);
    k = end;
  }
  return { tooLarge: false, added, removed, hunks };
}

module.exports = { diffLines };
