const { test, expect } = require('@playwright/test');
const fs = require('node:fs');
const path = require('node:path');
const { fixture, contentSnapshot } = require('../../../tests/dashboard-fixtures');
const { makeVault } = require('../../../tests/helpers');
const { createDashboard } = require('../../server/http');

let f, app, cleanup, outbound, errors;
test.beforeEach(async ({ page }) => {
  cleanup = []; outbound = []; errors = [];
  f = fixture({ after: fn => cleanup.unshift(fn) });
  fs.writeFileSync(path.join(f.source, 'browser-testing', 'SKILL.md'), '# Browser testing\n\n<script>window.untrustedRan = true</script>\n![image](https://example.com/private)');
  app = await createDashboard({ options: f.options });
  page.on('request', req => { if (!req.url().startsWith(app.url)) outbound.push(req.url()); });
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(app.url);
  await expect(page.getByRole('heading', { name: 'Projects', exact: true })).toBeVisible();
});
test.afterEach(async () => {
  expect(outbound).toEqual([]); expect(errors).toEqual([]);
  await app?.close(); for (const fn of cleanup) await fn();
});

const tray = page => page.locator('.tray');
async function applyAll(page, n) {
  const label = n === 1 ? 'Apply 1 change' : `Apply ${n} changes`;
  await expect(page.getByRole('button', { name: label })).toBeEnabled();
  await page.getByRole('button', { name: label }).click();
  await expect(tray(page)).toContainText(n === 1 ? 'Applied 1 change' : `Applied ${n} changes`);
  await page.getByRole('button', { name: 'Done' }).click();
  await expect(tray(page)).toHaveCount(0);
}

test('the board shows real wiring; a queued change writes nothing until applied', async ({ page }, info) => {
  const contrast = await page.evaluate(() => {
    const css = getComputedStyle(document.documentElement);
    const lum = v => { const h = css.getPropertyValue(v).trim().replace('#', ''); return [0, 2, 4].map(i => parseInt(h.slice(i, i + 2), 16) / 255).map(x => x <= .04045 ? x / 12.92 : ((x + .055) / 1.055) ** 2.4).reduce((a, x, i) => a + x * [.2126, .7152, .0722][i], 0); };
    return [['--ink', '--module'], ['--muted', '--panel'], ['--planned', '--module'], ['--live', '--module'], ['--caution', '--caution-tint'], ['--fault', '--fault-tint']]
      .map(([a, b]) => { const v = [lum(a), lum(b)].sort((x, y) => y - x); return { pair: `${a}/${b}`, ratio: (v[0] + .05) / (v[1] + .05) }; });
  });
  for (const c of contrast) expect(c.ratio, c.pair).toBeGreaterThanOrEqual(4.5);

  const project = page.getByRole('article', { name: 'project' });
  await expect(project).toContainText('Reads your vault only');
  await expect(project).toContainText('Reads another folder');
  await expect(page.getByRole('status').filter({ hasText: 'Out of date: 1 to add' })).toBeVisible();
  await page.screenshot({ path: info.outputPath('board-desktop.png'), fullPage: true });

  const before = contentSnapshot(f.root);
  await page.getByRole('button', { name: 'Rebuild the library' }).click();
  await expect(tray(page)).toContainText('Add 1 skill: sql-review');
  expect(contentSnapshot(f.root)).toEqual(before);
  await page.screenshot({ path: info.outputPath('board-tray.png'), fullPage: true });
  await applyAll(page, 1);
  await expect(page.getByRole('status').filter({ hasText: 'Up to date' })).toBeVisible();

  const sourceBefore = contentSnapshot(f.source);
  await page.getByRole('button', { name: 'Repoint Codex in project to the library' }).click();
  await expect(tray(page)).toContainText('That folder is not touched');
  await applyAll(page, 1);
  await expect(project).toContainText('Reads the library');
  await expect(project).not.toContainText('Reads another folder');
  expect(contentSnapshot(f.source)).toEqual(sourceBefore);
});

test('attach a folder, add a project and wire it, all from the board', async ({ page }) => {
  const extra = makeVault(f.root, 'extra', ['perf']);
  await page.getByRole('button', { name: 'Attach a repository' }).click();
  await page.getByLabel('Folder path or Git URL').fill(extra);
  await page.getByRole('button', { name: 'Attach', exact: true }).click();
  await expect(tray(page)).toContainText('1 skill found in it');
  await expect(page.getByRole('article', { name: 'Planned source' })).toBeVisible();
  await applyAll(page, 2);
  await expect(page.getByRole('article', { name: 'extra, 1 skill' })).toBeVisible();
  expect(fs.readlinkSync(path.join(f.homedir, '.agentforge', 'merged-skills', 'perf'))).toBeTruthy();

  const folder = path.join(f.root, 'new-app'); fs.mkdirSync(folder);
  await page.getByRole('button', { name: 'Add a project' }).click();
  await page.getByLabel('Project folder').fill(folder);
  await page.getByRole('button', { name: 'Add', exact: true }).click();
  await applyAll(page, 1);
  const added = page.getByRole('article', { name: 'new-app' });
  await expect(added).toContainText('No agents read skills here yet.');
  await added.getByRole('button', { name: 'Wire agents' }).click();
  await added.getByLabel('Gemini CLI').check();
  await added.getByRole('button', { name: 'Wire', exact: true }).click();
  await expect(tray(page)).toContainText('Link .gemini/skills to the library');
  await applyAll(page, 1);
  await expect(added).toContainText('Claude Code');
  await expect(added.locator('.agent.live')).toHaveCount(2);
  expect(fs.existsSync(path.join(folder, 'CLAUDE.md'))).toBe(true);
});

test('a change that cannot be made blocks Apply and says why', async ({ page }) => {
  await page.getByRole('button', { name: 'Attach a repository' }).click();
  await page.getByLabel('Folder path or Git URL').fill(path.join(f.root, 'does-not-exist'));
  await page.getByRole('button', { name: 'Attach', exact: true }).click();
  await expect(tray(page)).toContainText('one needs attention');
  await expect(tray(page)).toContainText('does not exist');
  await expect(page.getByRole('button', { name: /^Apply/ })).toBeDisabled();
  await page.getByRole('button', { name: 'Discard all' }).click();
  await expect(tray(page)).toHaveCount(0);
});

test('skill text is inert, refresh sees outside edits, and a failed refresh pauses reads', async ({ page }) => {
  await page.getByRole('link', { name: 'Skills', exact: true }).click();
  await page.getByRole('button', { name: 'browser-testing', exact: true }).click();
  await page.getByRole('button', { name: 'Read SKILL.md' }).click();
  await expect(page.getByLabel('SKILL.md contents')).toContainText('<script>window.untrustedRan = true</script>');
  expect(await page.evaluate(() => window.untrustedRan)).toBeUndefined();
  expect(await page.locator('pre script, pre img').count()).toBe(0);
  fs.writeFileSync(path.join(f.source, 'browser-testing', 'SKILL.md'), 'Updated outside dashboard');
  await page.getByRole('button', { name: 'Refresh' }).click();
  await page.getByRole('button', { name: 'Read SKILL.md' }).click();
  await expect(page.getByLabel('SKILL.md contents')).toContainText('Updated outside dashboard');
  fs.writeFileSync(f.registry, '{invalid');
  await page.getByRole('button', { name: 'Refresh' }).click();
  await expect(page.getByRole('alert')).toContainText('What you see may be out of date');
  await expect(page.getByRole('button', { name: 'Read SKILL.md' })).toBeDisabled();
  fs.writeFileSync(f.registry, JSON.stringify({ repositories: f.repos }));
  await page.getByRole('button', { name: 'Refresh' }).click();
  await expect(page.getByRole('button', { name: 'Read SKILL.md' })).toBeEnabled();
});

test('narrow screen and 200% zoom reflow; keyboard focus returns to the list', async ({ page }, info) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.emulateMedia({ reducedMotion: 'reduce' });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.screenshot({ path: info.outputPath('board-mobile.png'), fullPage: true });
  await page.getByRole('link', { name: 'Skills', exact: true }).click();
  await page.getByLabel('Search').fill('browser');
  const row = page.getByRole('button', { name: 'browser-testing', exact: true });
  await row.focus(); await page.keyboard.press('Enter');
  await expect(page.getByRole('button', { name: 'Back to the list' })).toBeVisible();
  await page.getByRole('button', { name: 'Back to the list' }).click();
  await expect(page.getByLabel('Search')).toHaveValue('browser');
  await expect(row).toBeFocused();
  expect(await row.evaluate(e => getComputedStyle(e).outlineStyle)).not.toBe('none');
  await page.setViewportSize({ width: 1500, height: 960 });
  await page.getByRole('link', { name: 'Wiring', exact: true }).click();
  await page.evaluate(() => { document.documentElement.style.zoom = '2'; });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});
