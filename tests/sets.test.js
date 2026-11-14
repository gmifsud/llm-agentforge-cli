'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { parseRule, validateSetName, globToRegExp, resolveSet } = require('../src/domain/sets');
const sets = require('../src/application/sets');
const { syncView } = require('../src/application/sync');
const { createPaths } = require('../src/infra/paths');
const { run } = require('../src/cli/main');
const { fixture } = require('./dashboard-fixtures');
const { tempRoot } = require('./helpers');

const REPO = path.resolve(__dirname, '..');
const lib = [
  { name: 'orcaflex-line-wizard', source: 'vault', category: 'offshore-engineering', absolutePath: '/x/1' },
  { name: 'orcaflex-batch-manager', source: 'vault', category: 'offshore-engineering', absolutePath: '/x/2' },
  { name: 'mooring-design', source: 'vault', category: 'offshore-engineering', absolutePath: '/x/3' },
  { name: 'github-actions', source: 'vault', category: 'devtools', absolutePath: '/x/4' },
  { name: 'tdd', source: 'obra', category: '', absolutePath: '/x/5' },
  { name: 'brainstorming', source: 'obra', category: '', absolutePath: '/x/6' },
];
const rules = (...texts) => ({ rules: texts.map((t) => (t.startsWith('-') ? parseRule(t.slice(1), { exclude: true }) : parseRule(t))) });
const names = (resolved) => resolved.entries.map((e) => e.name);

test('a rule is type:value, and says what is wrong when it is not', () => {
  assert.deepEqual(parseRule('category:offshore-engineering'), { type: 'category', value: 'offshore-engineering' });
  assert.deepEqual(parseRule('  name : orcaflex-*  '), { type: 'name', value: 'orcaflex-*' });
  assert.deepEqual(parseRule('skill:tdd', { exclude: true }), { type: 'skill', value: 'tdd', exclude: true });
  assert.deepEqual(parseRule('source:obra'), { type: 'source', value: 'obra' });
  assert.deepEqual(parseRule('category:a:b'), { type: 'category', value: 'a:b' }, 'only the first colon separates');
  assert.throws(() => parseRule('tdd'), /type:value/);
  assert.throws(() => parseRule('tag:x'), /skill, name, source or category/);
  assert.throws(() => parseRule('skill:'), /needs a value/);
  assert.throws(() => parseRule(':x'), /type:value/);
});

test('set names are safe folder names, and the library is not a set', () => {
  for (const ok of ['offshore', 'back-end', 'a.b_c', 'Set1']) assert.equal(validateSetName(ok), ok);
  for (const bad of ['', 'library', 'Library', 'vault', 'merged-skills', '../x', 'a b', '.hidden', 'x'.repeat(65), 'a/b', 'a\\b']) assert.throws(() => validateSetName(bad), undefined, JSON.stringify(bad));
});

test('a pattern uses * and ? only, ignores case, and must match the whole name', () => {
  const m = (p, s) => globToRegExp(p).test(s);
  assert.ok(m('orcaflex-*', 'orcaflex-line-wizard') && m('ORCAFLEX-*', 'orcaflex-x'));
  assert.ok(m('orcaflex-line-wiz?rd', 'orcaflex-line-wizard'));
  assert.ok(!m('flex', 'orcaflex'), 'not a substring match');
  assert.ok(!m('a.c', 'abc'), 'a dot is a dot, not any character');
  assert.ok(m('a+b(c)', 'a+b(c)'), 'regex characters are literal');
});

test('rules apply in order: include adds, exclude removes, a later include can put a skill back', () => {
  const r = resolveSet(rules('category:offshore-engineering', 'name:orcaflex-*', 'skill:tdd', '-skill:orcaflex-batch-manager'), lib);
  assert.deepEqual(names(r), ['mooring-design', 'orcaflex-line-wizard', 'tdd']);
  assert.deepEqual(r.rules.map((x) => [x.matched, x.added, x.removed]), [[3, 3, 0], [2, 0, 0], [1, 1, 0], [1, 0, 1]], 'matched, newly added, newly removed per rule');

  assert.ok(names(resolveSet(rules('category:offshore-engineering', '-skill:mooring-design', 'skill:mooring-design'), lib)).includes('mooring-design'), 'the last rule wins');
  assert.ok(!names(resolveSet(rules('skill:mooring-design', '-category:offshore-engineering'), lib)).includes('mooring-design'));
  assert.deepEqual(names(resolveSet(rules('-skill:tdd'), lib)), [], 'an exclude with nothing before it leaves nothing');
});

test('matching ignores case, reads the source and category, and the order of the library does not matter', () => {
  assert.deepEqual(names(resolveSet(rules('category:OFFSHORE-Engineering'), lib)).length, 3);
  assert.deepEqual(names(resolveSet(rules('source:OBRA'), lib)), ['brainstorming', 'tdd']);
  assert.deepEqual(names(resolveSet(rules('skill:TDD'), lib)), ['tdd']);
  assert.equal(JSON.stringify(resolveSet(rules('source:vault'), lib)), JSON.stringify(resolveSet(rules('source:vault'), [...lib].reverse())), 'the same set whichever way the library is listed');
});

test('a rule that matches nothing is reported, so a typo is never saved quietly', () => {
  const r = resolveSet(rules('skill:no-such-skill', 'name:zzz-*', 'category:nothing', 'source:nowhere', 'skill:tdd'), lib);
  assert.deepEqual(names(r), ['tdd']);
  assert.deepEqual(r.unmatched.map((x) => `${x.type}:${x.value}`), ['skill:no-such-skill', 'name:zzz-*', 'category:nothing', 'source:nowhere']);
  assert.deepEqual(resolveSet(rules('-skill:nothing'), lib).unmatched, [], 'an exclude that matches nothing is harmless');
});

test('the store: none yet is empty, damaged is refused (never overwritten), and saved sets are in name order', (t) => {
  const paths = createPaths({ homedir: tempRoot(t), scriptDir: REPO });
  assert.deepEqual(sets.loadSets(paths), { version: 1, sets: {} });
  sets.saveSets(paths, { version: 1, sets: { zeta: rules('skill:a'), alpha: rules('skill:b') } });
  assert.deepEqual(Object.keys(sets.loadSets(paths).sets), ['alpha', 'zeta']);
  fs.writeFileSync(sets.setsFile(paths), '{ nope');
  assert.throws(() => sets.loadSets(paths), (e) => e.code === 'CONFIG_CORRUPT');
  fs.writeFileSync(sets.setsFile(paths), JSON.stringify({ version: 1, sets: { x: { rules: [{ type: 'tag', value: 'y' }] } } }));
  assert.throws(() => sets.loadSets(paths), (e) => e.code === 'CONFIG_INVALID');
  fs.writeFileSync(sets.setsFile(paths), JSON.stringify({ version: 1, sets: { 'bad name': { rules: [] } } }));
  assert.throws(() => sets.loadSets(paths), (e) => e.code === 'CONFIG_INVALID');
});

/** The fixture's library, with categories added to a few skills (the vault is a plain folder, so it can be written in a test). */
function categorised(f) {
  const put = (dir, name, category) => fs.writeFileSync(path.join(dir, name, 'SKILL.md'), `---\nname: ${name}\ndescription: ${name} description from ${path.basename(dir)}\ncategory: ${category}\n---\n# ${name}\n`);
  put(f.vault, 'sql-review', 'data'); put(f.vault, 'frontend-design', 'ui'); put(f.source, 'browser-testing', 'ui');
}
const pathsOf = (f) => createPaths({ homedir: f.homedir, scriptDir: REPO });
const build = (f, extra = {}) => syncView({ paths: pathsOf(f), env: {}, fetch: false, git: {}, ...extra });
const listing = (dir) => fs.readdirSync(dir).sort();

test('every build makes each set a real folder of links beside the library, from the library\'s winners', (t) => {
  const f = fixture(t); categorised(f);
  const paths = pathsOf(f);
  sets.saveSets(paths, { version: 1, sets: { ui: rules('category:ui'), lab: rules('source:frontend-lab') } });

  const first = build(f);
  assert.deepEqual(first.sets.map((s) => [s.name, s.linked]), [['lab', 1], ['ui', 2]]);
  assert.deepEqual(listing(sets.setView(paths, 'ui')), ['browser-testing', 'frontend-design']);
  // frontend-design exists in the vault and in frontend-lab; the library chose the vault's, and a set follows it.
  assert.equal(fs.realpathSync(path.join(sets.setView(paths, 'ui'), 'frontend-design')), fs.realpathSync(path.join(f.vault, 'frontend-design')));
  assert.deepEqual(listing(sets.setView(paths, 'lab')), ['browser-testing'], 'source:frontend-lab matches only what that source won in the library');
  assert.ok(fs.existsSync(path.join(paths.mergedSkills, 'sql-review')), 'the library itself is still built');
  assert.ok(!fs.existsSync(path.join(sets.setView(paths, 'ui'), 'sql-review')), 'and the set holds only its own skills');

  // A change to the rules, or to the skills, shows at the next build.
  sets.saveSets(paths, { version: 1, sets: { ui: rules('category:ui', 'skill:sql-review'), lab: rules('source:frontend-lab') } });
  assert.deepEqual(build(f).sets.find((s) => s.name === 'ui').linked, 3);
  assert.deepEqual(listing(sets.setView(paths, 'ui')), ['browser-testing', 'frontend-design', 'sql-review']);
});

test('a dry run says what would be built and writes nothing; a folder holding anything but links is refused', (t) => {
  const f = fixture(t); categorised(f);
  const paths = pathsOf(f);
  sets.saveSets(paths, { version: 1, sets: { ui: rules('category:ui') } });
  const dry = build(f, { dryRun: true });
  assert.deepEqual(dry.sets.map((s) => [s.name, s.count]), [['ui', 2]]);
  assert.ok(!fs.existsSync(paths.viewsDir), 'nothing written');

  build(f);
  fs.writeFileSync(path.join(sets.setView(paths, 'ui'), 'notes.txt'), 'mine');
  assert.throws(() => build(f), (e) => e.code === 'VIEW_SHAPE', 'user data in a set folder is never replaced');
  assert.equal(fs.readFileSync(path.join(sets.setView(paths, 'ui'), 'notes.txt'), 'utf8'), 'mine');
});

test('a set\'s listing budget is estimated from its own skills', () => {
  const long = (n) => ({ description: 'x'.repeat(n) });
  const small = sets.setBudget([long(40), long(40)], { budgetChars: 100 });
  assert.deepEqual([small.entries, small.kept, small.dropped, small.fits], [2, 2, 0, true]);
  const big = sets.setBudget([long(60), long(60), long(60)], { budgetChars: 100 });
  assert.deepEqual([big.entries, big.kept, big.dropped, big.fits], [3, 1, 2, false]);
});

test('which set, or the library, a link reads', (t) => {
  const f = fixture(t);
  const paths = pathsOf(f);
  sets.saveSets(paths, { version: 1, sets: { ui: rules('skill:x') } });
  assert.deepEqual(sets.readsOf(paths, paths.mergedSkills), { kind: 'library' });
  assert.deepEqual(sets.readsOf(paths, sets.setView(paths, 'ui')), { kind: 'set', name: 'ui' });
  assert.deepEqual(sets.readsOf(paths, path.join(f.root, 'elsewhere')), { kind: 'other' });
  assert.deepEqual(sets.readsOf(paths, undefined), { kind: 'other' });
});

// ─── the command line ──────────────────────────────────────────────────────────────────────
function cli(f) {
  return (argv) => {
    let out = '', err = '';
    const code = run(argv, { homedir: f.homedir, env: {}, stdout: { write: (s) => { out += s; }, isTTY: false }, stderr: { write: (s) => { err += s; }, isTTY: false }, cwd: f.root });
    return { code, out, err };
  };
}

test('set create, list, show: rules from the command line, built at once, with counts and a budget', (t) => {
  const f = fixture(t); categorised(f);
  const go = cli(f), paths = pathsOf(f);
  const made = go(['set', 'create', 'ui', '--include', 'category:ui', '--include', 'skill:sql-review', '--exclude', 'skill:browser-testing']);
  assert.equal(made.code, 0, made.err);
  assert.match(made.out, /set "ui": 2 skills/);
  assert.deepEqual(listing(sets.setView(paths, 'ui')), ['frontend-design', 'sql-review']);

  const dup = go(['set', 'create', 'ui', '--include', 'skill:tdd']);
  assert.equal(dup.code, 3, 'an existing set is not replaced by accident');
  assert.match(dup.err, /already exists/);
  assert.equal(go(['set', 'create', 'ui', '--include', 'skill:sql-review', '--force']).code, 0);
  assert.deepEqual(listing(sets.setView(paths, 'ui')), ['sql-review']);

  assert.equal(go(['set', 'create', 'bad', '--include', 'skill:nope']).code, 3, 'a rule that matches nothing is refused, not saved quietly');
  assert.ok(!sets.loadSets(paths).sets.bad);
  assert.equal(go(['set', 'create', 'x']).code, 2, 'a set needs at least one include rule');
  assert.equal(go(['set', 'create', 'library', '--include', 'skill:a']).code, 2);

  assert.deepEqual(JSON.parse(go(['set', 'list', '--json']).out), [{ name: 'ui', rules: 1, skills: 1 }]);
  const shown = JSON.parse(go(['set', 'show', 'ui', '--json']).out);
  assert.deepEqual(shown.skills, ['sql-review']);
  assert.deepEqual(shown.rules.map((r) => [r.type, r.value, r.matched, r.added]), [['skill', 'sql-review', 1, 1]]);
  assert.equal(shown.budget.entries, 1);
  assert.equal(shown.budget.fits, true);
  assert.match(go(['set', 'show', 'ui']).out, /every description fits/);
  assert.equal(go(['set', 'show', 'nope']).code, 3);
});

test('link --set points an agent at a set, doctor says so, and removing a set in use is refused', (t) => {
  const f = fixture(t); categorised(f);
  const go = cli(f), paths = pathsOf(f);
  assert.equal(go(['set', 'create', 'ui', '--include', 'category:ui']).code, 0);
  const proj = path.join(f.root, 'proj'); fs.mkdirSync(proj);

  assert.equal(go(['link', '--path', proj, '--target', 'claude', '--set', 'nope']).code, 3, 'a set that does not exist cannot be linked');
  const linked = go(['link', '--path', proj, '--target', 'claude', '--set', 'ui']);
  assert.equal(linked.code, 0, linked.err);
  assert.equal(fs.realpathSync(path.join(proj, '.claude', 'skills')), fs.realpathSync(sets.setView(paths, 'ui')), 'the agent\'s one folder link now points at the set');
  assert.match(go(['doctor', '--path', proj]).out, /reads set ui/);
  assert.deepEqual(sets.readsOf(paths, fs.realpathSync(path.join(proj, '.claude', 'skills'))), { kind: 'set', name: 'ui' });

  fs.writeFileSync(path.join(f.homedir, '.agentforge', 'projects.json'), JSON.stringify({ projects: [proj] }));
  const blocked = go(['set', 'remove', 'ui']);
  assert.equal(blocked.code, 3);
  assert.match(blocked.err, /read by 1 agent/); assert.match(blocked.err, /claude/);
  assert.ok(fs.existsSync(sets.setView(paths, 'ui')), 'nothing was removed');

  const forced = go(['set', 'remove', 'ui', '--force']);
  assert.equal(forced.code, 0, forced.err);
  assert.ok(!fs.existsSync(sets.setView(paths, 'ui')) && !sets.loadSets(paths).sets.ui);
  assert.ok(fs.existsSync(path.join(f.vault, 'sql-review')), 'the skills themselves are untouched');
});

test('update builds every set with the library; a dry run only says so', (t) => {
  const f = fixture(t); categorised(f);
  const go = cli(f), paths = pathsOf(f);
  assert.equal(go(['set', 'create', 'ui', '--include', 'category:ui']).code, 0);
  fs.mkdirSync(path.join(f.vault, 'new-ui'));
  fs.writeFileSync(path.join(f.vault, 'new-ui', 'SKILL.md'), '---\nname: new-ui\ndescription: new\ncategory: ui\n---\n');

  const dry = go(['update', '--no-fetch', '--dry-run']);
  assert.match(dry.out, /would build 1 set/);
  assert.deepEqual(listing(sets.setView(paths, 'ui')), ['browser-testing', 'frontend-design'], 'a dry run leaves the set alone');

  const real = go(['update', '--no-fetch']);
  assert.equal(real.code, 0, real.err);
  assert.match(real.out, /sets built: ui \(3 skills\)/);
  assert.deepEqual(listing(sets.setView(paths, 'ui')), ['browser-testing', 'frontend-design', 'new-ui']);
  assert.equal(go(['set', 'build']).code, 0, 'set build rebuilds the sets without touching the library');
});

test('a set is never a source: it cannot be attached, or used as the vault', (t) => {
  const f = fixture(t); categorised(f);
  const go = cli(f), paths = pathsOf(f);
  assert.equal(go(['set', 'create', 'ui', '--include', 'category:ui']).code, 0);
  const attach = go(['repo', 'add', sets.setView(paths, 'ui'), '--name', 'myset']);
  assert.equal(attach.code, 3);
  assert.match(attach.err, /is a set, not a source/);
  assert.equal(go(['repo', 'add', paths.viewsDir, '--name', 'allsets']).code, 3, 'nor the folder that holds the sets');
  assert.equal(go(['repo', 'add', paths.mergedSkills, '--name', 'lib']).code, 3, 'nor the library');
  const asVault = go(['repo', 'sync', '--no-fetch', '--vault', sets.setView(paths, 'ui')]);
  assert.notEqual(asVault.code, 0);
  assert.match(asVault.err, /is a set, not a source/);
});
