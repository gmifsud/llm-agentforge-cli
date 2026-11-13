'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { inspectProject } = require('../src/application/project');
const { tempRoot, makeVault, mkLink } = require('./helpers');

/** A library the way the tool builds it: a folder of links, one per skill. */
function libraryOfLinks(root, names) {
  const vault = makeVault(root, 'vault', names);
  const library = path.join(root, 'library'); fs.mkdirSync(library);
  for (const n of names) mkLink(path.join(vault, n), path.join(library, n));
  return { vault, library };
}
function projects(root, count) {
  return Array.from({ length: count }, (_, i) => {
    const dir = path.join(root, `project-${i}`); fs.mkdirSync(path.join(dir, '.claude'), { recursive: true });
    return dir;
  });
}
/** Counts the library entries each scan looks at: one boundary check per entry means one scan. */
function counting(library) {
  const state = { entries: 0, check: (p) => { if (p.startsWith(library + path.sep)) state.entries++; } };
  return state;
}

test('sharing the library scan gives every project the same report as scanning it each time', (t) => {
  const root = tempRoot(t);
  const { library } = libraryOfLinks(root, ['a', 'b', 'c', 'd']);
  const list = projects(root, 3);
  const alone = list.map((projectRoot) => inspectProject({ projectRoot, vaultRoot: library }));
  const scan = new Map();
  const shared = list.map((projectRoot) => inspectProject({ projectRoot, vaultRoot: library, scan }));
  assert.deepEqual(shared, alone);
  assert.equal(shared[0].vault.skills, 4);
});

test('the library is scanned once however many projects are inspected', (t) => {
  const root = tempRoot(t);
  const { library } = libraryOfLinks(root, ['a', 'b', 'c', 'd', 'e']);
  const list = projects(root, 6);

  const each = counting(library);
  for (const projectRoot of list) inspectProject({ projectRoot, vaultRoot: library, checkRead: each.check });

  const once = counting(library), scan = new Map();
  for (const projectRoot of list) inspectProject({ projectRoot, vaultRoot: library, checkRead: once.check, scan });

  assert.ok(each.entries >= 6 * once.entries, `unshared scans repeat the work (${each.entries} vs ${once.entries})`);
  assert.ok(once.entries > 0, 'the scan still looks at the library entries');
  // Six projects, one scan: the work is that of a single project, not six.
  const single = counting(library);
  inspectProject({ projectRoot: list[0], vaultRoot: library, checkRead: single.check });
  assert.equal(once.entries, single.entries);
});

test('a scan is only valid for one read: a fresh scan sees a changed library', (t) => {
  const root = tempRoot(t);
  const { vault, library } = libraryOfLinks(root, ['a', 'b']);
  const [project] = projects(root, 1);
  const scan = new Map();
  assert.equal(inspectProject({ projectRoot: project, vaultRoot: library, scan }).vault.skills, 2);

  makeVault(root, 'vault', ['c']);
  mkLink(path.join(vault, 'c'), path.join(library, 'c'));

  assert.equal(inspectProject({ projectRoot: project, vaultRoot: library, scan }).vault.skills, 2, 'the same scan keeps its answer for the rest of that read');
  assert.equal(inspectProject({ projectRoot: project, vaultRoot: library, scan: new Map() }).vault.skills, 3, 'the next read scans again');
  assert.equal(inspectProject({ projectRoot: project, vaultRoot: library }).vault.skills, 3, 'with no scan given, nothing is remembered');
});
