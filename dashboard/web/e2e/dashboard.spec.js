const { test, expect } = require('@playwright/test');
const fs = require('node:fs');
const path = require('node:path');
const { fixture, contentSnapshot } = require('../../../tests/dashboard-fixtures');
const { createDashboard } = require('../../server/http');

let f, app, cleanup, before;
test.beforeEach(async ({ page }) => {
  cleanup = [];
  f = fixture({ after: fn => cleanup.unshift(fn) });
  fs.writeFileSync(path.join(f.source, 'browser-testing', 'SKILL.md'), '# Browser testing\n\n<script>window.untrustedRan = true</script>\n![image](https://example.com/private)');
  app = await createDashboard({ options: f.options });
  before = contentSnapshot(f.root);
  await page.goto(app.url);
  await expect(page.getByRole('button', { name: 'Refresh local data' })).toBeEnabled();
  await expect(page.getByRole('button', { name: 'frontend-lab', exact: true })).toBeVisible();
});
test.afterEach(async () => { await app?.close(); for (const fn of cleanup) await fn(); });

test('sources, skill inspection, project diagnostics and content are read-only', async ({ page }, info) => {
  const outbound = [], errors = [];
  page.on('request', req => { if (!req.url().startsWith(app.url)) outbound.push(req.url()); });
  page.on('pageerror', error => errors.push(error.message));
  await page.getByRole('button', { name: 'frontend-lab', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'frontend-lab', exact: true })).toBeVisible();
  const contrast = await page.evaluate(() => {
    const css = getComputedStyle(document.documentElement);
    const luminance = variable => {
      const hex = css.getPropertyValue(variable).trim().replace('#', '');
      const full = hex.length === 3 ? hex.split('').map(x => x + x).join('') : hex;
      const rgb = [0, 2, 4].map(i => parseInt(full.slice(i, i + 2), 16) / 255).map(x => x <= .04045 ? x / 12.92 : ((x + .055) / 1.055) ** 2.4);
      return rgb[0] * .2126 + rgb[1] * .7152 + rgb[2] * .0722;
    };
    return [['--ink', '--surface'], ['--muted', '--canvas'], ['--accent', '--surface'], ['--warn', '--warn-bg']].map(([a, b]) => {
      const values = [luminance(a), luminance(b)].sort((x, y) => y - x);
      return { pair: `${a}/${b}`, ratio: (values[0] + .05) / (values[1] + .05) };
    });
  });
  for (const check of contrast) expect(check.ratio, check.pair).toBeGreaterThanOrEqual(4.5);
  await page.screenshot({ path: info.outputPath('sources-desktop.png'), fullPage: true });
  await page.getByRole('button', { name: 'View skills', exact: true }).click();
  await expect(page.locator('#source-filter option:checked')).toHaveText('frontend-lab');
  await page.getByRole('button', { name: 'browser-testing', exact: true }).click();
  await page.getByRole('button', { name: 'Read full SKILL.md' }).click();
  await expect(page.getByLabel('Skill document')).toContainText('<script>window.untrustedRan = true</script>');
  expect(await page.evaluate(() => window.untrustedRan)).toBeUndefined();
  expect(await page.locator('pre script, pre img').count()).toBe(0);
  await page.screenshot({ path: info.outputPath('skills-desktop.png'), fullPage: true });
  await page.getByRole('link', { name: 'Projects', exact: true }).click();
  await page.getByLabel('Project', { exact: true }).selectOption({ index: 1 });
  await page.getByRole('button', { name: 'Inspect project', exact: true }).click();
  await expect(page.getByRole('cell', { name: 'matches', exact: true })).toBeVisible();
  await expect(page.getByRole('cell', { name: 'differs', exact: true })).toBeVisible();
  await page.screenshot({ path: info.outputPath('projects-desktop.png'), fullPage: true });
  await page.getByRole('link', { name: 'Sources', exact: true }).click();
  await page.getByRole('link', { name: 'Projects', exact: true }).click();
  await expect(page.locator('#project-select option:checked')).toContainText('project /');
  expect(outbound).toEqual([]); expect(errors).toEqual([]);
  expect(contentSnapshot(f.root)).toEqual(before);
});

test('refresh observes external edits and failed refresh visibly pauses document reads', async ({ page }) => {
  await page.getByRole('link', { name: 'Skills', exact: true }).click();
  await page.getByRole('button', { name: 'browser-testing', exact: true }).click();
  fs.writeFileSync(path.join(f.source, 'browser-testing', 'SKILL.md'), 'Updated outside dashboard');
  await page.getByRole('button', { name: 'Refresh local data' }).click();
  await expect(page.getByRole('button', { name: 'Read full SKILL.md' })).toBeEnabled();
  await page.getByRole('button', { name: 'Read full SKILL.md' }).click();
  await expect(page.getByLabel('Skill document')).toContainText('Updated outside dashboard');
  fs.writeFileSync(f.registry, '{invalid');
  await page.getByRole('button', { name: 'Refresh local data' }).click();
  await expect(page.getByRole('alert')).toContainText('Showing stale data');
  await expect(page.getByRole('button', { name: 'Read full SKILL.md' })).toBeDisabled();
  fs.writeFileSync(f.registry, JSON.stringify({ repositories: f.repos }));
  await page.getByRole('button', { name: 'Refresh local data' }).click();
  await expect(page.getByRole('button', { name: 'Read full SKILL.md' })).toBeEnabled();
});

test('narrow screen keeps filters and keyboard focus when returning from inspector', async ({ page }, info) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.getByRole('link', { name: 'Skills', exact: true }).click();
  await page.getByLabel('Search skills').fill('browser');
  const row = page.getByRole('button', { name: 'browser-testing', exact: true });
  await row.focus(); await page.keyboard.press('Enter');
  await expect(page.getByRole('button', { name: 'Back to skills' })).toBeVisible();
  await page.getByRole('button', { name: 'Read full SKILL.md' }).click();
  await expect(page.getByLabel('Skill document')).toBeVisible();
  await page.screenshot({ path: info.outputPath('skills-mobile.png'), fullPage: true });
  await page.getByRole('button', { name: 'Back to skills' }).click();
  await expect(page.getByLabel('Search skills')).toHaveValue('browser');
  await expect(row).toBeFocused();
  const focused = await row.evaluate(e => getComputedStyle(e).outlineStyle);
  expect(focused).not.toBe('none');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  // Desktop at 200% effective CSS zoom: verify reflow without page-level overflow.
  await page.setViewportSize({ width: 1500, height: 960 });
  await page.evaluate(() => { document.documentElement.style.zoom = '2'; });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});

test('keyboard can navigate from the source list to skill text', async ({ page }) => {
  await page.getByRole('button', { name: 'frontend-lab', exact: true }).focus();
  await page.keyboard.press('Enter');
  // Native tab order: selected row -> View skills in the adjacent inspector.
  await page.keyboard.press('Tab');
  await expect(page.getByRole('button', { name: 'View skills', exact: true })).toBeFocused();
  await page.keyboard.press('Enter');
  await page.getByRole('button', { name: 'browser-testing', exact: true }).focus();
  await page.keyboard.press('Enter');
  await page.getByRole('button', { name: 'Read full SKILL.md' }).focus();
  await page.keyboard.press('Enter');
  await expect(page.getByLabel('Skill document')).toBeVisible();
});
