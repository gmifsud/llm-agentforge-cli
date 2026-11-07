'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { validateSourceId, deriveSourceId, isGitUrl } = require('../src/domain/source-id');
const { renderString } = require('../src/render-template');
const { parseArgs } = require('../src/cli/args');
const { resolveTargets, TARGET_IDS } = require('../src/domain/targets');

test('source IDs cannot traverse out of the cache', () => {
  for (const bad of ['..', '.', '../x', 'a/b', 'a\\b', '', ' ', 'x'.repeat(65), '-leading', '.hidden']) {
    assert.throws(() => validateSourceId(bad), { exitCode: 2 }, `should reject ${JSON.stringify(bad)}`);
  }
  for (const good of ['mattpocock', 'my_repo-1', 'a.b', 'A1']) assert.equal(validateSourceId(good), good);
});

test('deriveSourceId strips .git and path separators', () => {
  assert.equal(deriveSourceId('https://github.com/x/llm-skills.git'), 'llm-skills');
  assert.equal(deriveSourceId('git@github.com:x/y.git'), 'y');
  assert.equal(deriveSourceId('C:\\Repos\\LLM\\vault\\'), 'vault');
});

test('git URL schemes are restricted', () => {
  assert.ok(isGitUrl('https://github.com/a/b'));
  assert.ok(isGitUrl('git@github.com:a/b.git'));
  assert.ok(isGitUrl('ssh://git@host/a/b'));
  assert.ok(!isGitUrl('file:///etc'));
  assert.ok(!isGitUrl('ext::sh -c whoami'));
  assert.ok(!isGitUrl('C:\\Repos\\x'));
});

test('template rendering is literal (sed-unsafe characters survive)', () => {
  const out = renderString('a=${A} b=${B} a2=${A}', { A: 'pnpm build && pnpm test | tee', B: 'C:\\x\\y&$1' });
  assert.equal(out, 'a=pnpm build && pnpm test | tee b=C:\\x\\y&$1 a2=pnpm build && pnpm test | tee');
});

test('args: PowerShell and GNU spellings normalize to the same options', () => {
  const a = parseArgs(['init', '-Path', 'X', '-Target', 'all', '-DryRun', '-NoPreserve', '-VaultRoot', 'V', '-LinkType', 'copy']);
  const b = parseArgs(['init', '--path', 'X', '--target=all', '--dry-run', '--no-preserve', '--vault', 'V', '--link:copy']);
  assert.deepEqual(a, b);
  assert.equal(a.command, 'init');
  assert.deepEqual(a.opts, { path: 'X', target: 'all', dryRun: true, noPreserve: true, vault: 'V', link: 'copy' });
});

test('args: repo subcommand keeps positionals and rejects unknown options', () => {
  const p = parseArgs(['repo', 'add', 'https://x/y.git', '--name', 'n', '--branch', 'dev']);
  assert.deepEqual(p.positional, ['add', 'https://x/y.git']);
  assert.deepEqual(p.opts, { name: 'n', branch: 'dev' });
  assert.throws(() => parseArgs(['init', '--bogus']), { exitCode: 2 });
  assert.throws(() => parseArgs(['init', '--path']), { exitCode: 2 });
});

test('targets: all expands to every id, unknown is a usage error', () => {
  assert.deepEqual(resolveTargets('all').map((t) => t.id), TARGET_IDS);
  assert.equal(resolveTargets(undefined)[0].id, 'claude');
  assert.throws(() => resolveTargets('cursor'), { exitCode: 2 });
});
