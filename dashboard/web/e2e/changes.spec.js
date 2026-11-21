const { test, expect } = require('@playwright/test');
const fs = require('node:fs');
const { fixture, contentSnapshot } = require('../../../tests/dashboard-fixtures');
const { createDashboard } = require('../../server/http');

let f, app, cleanup, errors;
test.beforeEach(async ({ page }) => {
  cleanup = []; errors = [];
  f = fixture({ after: fn => cleanup.unshift(fn) });
  fs.writeFileSync(f.registry, JSON.stringify({ repositories: [...f.repos,
    ...Array.from({ length: 24 }, (_, i) => ({ name: `fixture-${i}`, type: 'git', url_or_path: `https://example.com/fixture-${i}.git` })),
  ] }));
  app = await createDashboard({ options: f.options });
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(app.url);
  await expect(page.getByRole('heading', { name: 'Fleet', exact: true })).toBeVisible();
});
test.afterEach(async () => {
  await app?.close();
  for (const fn of cleanup) await fn();
  expect(errors).toEqual([]);
});
const review = page => page.getByRole('dialog', { name: 'Review changes', exact: true });
const open = page => page.locator('#changes-control').click();
async function queue25(page) {
  await page.getByRole('button', { name: 'Fetch all updates (24)' }).click();
  await expect(page.locator('#changes-control')).toContainText('25');
}
async function openWiring(page) {
  await page.locator('[data-select^="project:"]').first().click();
  await page.getByRole('link', { name: 'Show wiring', exact: true }).click();
}

test('25 changes stay compact or hidden across navigation and enqueue; modal collapse and focus work', async ({ page }, info) => {
  const before = contentSnapshot(f.root);
  await queue25(page);
  await openWiring(page);
  await expect(review(page)).not.toBeVisible();
  await expect(page.getByRole('button', { name: 'Review changes', exact: true })).toBeVisible();
  await open(page);
  await expect(review(page).getByRole('heading', { name: 'Review changes' })).toBeFocused();
  await expect(review(page).locator('li.step')).toHaveCount(25);
  await page.screenshot({ path: info.outputPath('changes-review-desktop.png') });
  await review(page).getByRole('button', { name: 'Collapse', exact: true }).click();
  await expect(review(page)).not.toBeVisible();
  await expect(page.locator('#changes-control')).toBeFocused();
  await page.getByRole('button', { name: 'Review changes', exact: true }).click();
  await review(page).getByRole('button', { name: 'Hide', exact: true }).click();
  await expect(page.getByRole('complementary', { name: 'Pending changes' })).toHaveCount(0);
  await expect(page.locator('#changes-control')).toBeFocused();
  await page.getByRole('link', { name: 'Skills', exact: true }).click();
  await open(page);
  await expect(review(page).locator('li.step')).toHaveCount(25);
  await page.keyboard.press('Escape');
  await page.getByRole('link', { name: 'Fleet', exact: true }).click();
  await page.getByRole('button', { name: 'Move frontend-lab up', exact: true }).click();
  await expect(page.locator('#changes-control')).toContainText('26');
  await expect(review(page)).not.toBeVisible();
  await expect(page.getByRole('complementary', { name: 'Pending changes' })).toHaveCount(0);
  expect(contentSnapshot(f.root)).toEqual(before);
  await page.reload();
  await open(page);
  await expect(review(page)).toContainText('No changes queued');
  expect(await page.evaluate(() => localStorage.getItem('agentforge.changes.presentation.v1'))).toBe('hidden');
});

test('pending previews do not reopen collapsed review', async ({ page }) => {
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  await page.route('**/api/v1/changes/preview', async route => { await gate; await route.continue(); });
  try {
    await queue25(page);
    await openWiring(page);
    await open(page);
    await expect(review(page)).toContainText('Checking your changes');
    await review(page).getByRole('button', { name: 'Collapse', exact: true }).focus();
    await page.keyboard.press('Enter');
    await expect(review(page)).not.toBeVisible();
    release();
    await open(page);
    await expect(review(page).getByRole('button', { name: 'Apply 25 changes' })).toBeEnabled();
    await page.keyboard.press('Escape');
    await expect(review(page)).not.toBeVisible();
    await expect(page.locator('#changes-control')).toBeFocused();
  } finally { release(); }
});

test('acknowledged outcomes appear during apply; hiding, collapse and Done never replay a run', async ({ page }, info) => {
  await queue25(page);
  await openWiring(page);
  let sent = 0, release;
  const gate = new Promise(resolve => { release = resolve; });
  await page.route('**/api/v1/changes/apply', async route => {
    const index = sent++;
    if (index === 1) await gate;
    const change = route.request().postDataJSON().changes[0];
    await route.fulfill({ json: { results: [{ kind: change.kind, title: `Fixture step ${index + 1}`, status: index === 0 ? 'failed' : 'applied', lines: [], message: index === 0 ? 'Fixture source unavailable' : '' }] } });
  });
  const before = contentSnapshot(f.root);
  try {
    await open(page);
    await review(page).getByRole('button', { name: 'Apply 25 changes' }).click();
    await expect.poll(() => sent).toBe(2);
    await expect(review(page).locator('li.step').nth(0)).toContainText('Failed');
    await expect(review(page).locator('li.step').nth(1)).toContainText('Running');
    await expect(review(page).locator('.elapsed')).toBeVisible();
    await expect(review(page).getByRole('button', { name: 'Discard all' })).toBeDisabled();
    await expect(review(page).getByRole('button', { name: /^Remove step/ })).toHaveCount(0);
    await page.screenshot({ path: info.outputPath('changes-running.png') });
    await review(page).getByRole('button', { name: 'Collapse', exact: true }).click();
    await expect(review(page)).not.toBeVisible();
    await page.getByRole('button', { name: 'View progress' }).click();
    await expect(review(page).locator('li.step').nth(0)).toContainText('Failed');
    await review(page).getByRole('button', { name: 'Hide', exact: true }).click();
    await open(page);
    // A real native unload event is cancelled while applying; do not reload a running batch.
    expect(await page.evaluate(() => { const event = new Event('beforeunload', { cancelable: true }); window.dispatchEvent(event); return event.defaultPrevented; })).toBe(true);
    release();
    await expect(review(page).getByRole('button', { name: 'Done', exact: true })).toBeVisible();
    await expect(review(page)).toContainText('25 finished · 24 applied · 1 need attention');
    expect(sent).toBe(25);
    await page.keyboard.press('Escape');
    await open(page);
    await expect(review(page).locator('li.result')).toHaveCount(25);
    await review(page).getByRole('button', { name: 'Done', exact: true }).click();
    await expect(review(page)).not.toBeVisible();
    expect(sent).toBe(25);
    expect(contentSnapshot(f.root)).toEqual(before);
    expect(await page.evaluate(() => { const event = new Event('beforeunload', { cancelable: true }); window.dispatchEvent(event); return event.defaultPrevented; })).toBe(false);
  } finally { release(); }
});

for (const viewport of [{ width: 390, height: 844 }, { width: 1366, height: 768 }, { width: 1920, height: 1080 }]) {
  test(`review stays within ${viewport.width}px and traps keyboard focus`, async ({ page }, info) => {
    await page.setViewportSize(viewport);
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await queue25(page);
    await openWiring(page);
    await open(page);
    const dialog = review(page);
    const box = await dialog.boundingBox();
    expect(box.x).toBeGreaterThanOrEqual(0);
    expect(box.y).toBeGreaterThanOrEqual(0);
    expect(box.x + box.width).toBeLessThanOrEqual(viewport.width);
    expect(box.y + box.height).toBeLessThanOrEqual(viewport.height);
    await expect(dialog.getByRole('button', { name: 'Apply 25 changes' })).toBeEnabled();
    await dialog.getByRole('button', { name: 'Apply 25 changes' }).focus();
    await page.keyboard.press('Tab');
    await expect(dialog.getByRole('button', { name: 'Collapse', exact: true })).toBeFocused();
    await page.keyboard.press('Shift+Tab');
    await expect(dialog.getByRole('button', { name: 'Apply 25 changes' })).toBeFocused();
    await page.screenshot({ path: info.outputPath(`changes-${viewport.width}.png`) });
    await page.keyboard.press('Escape');
    await expect(page.locator('#changes-control')).toBeFocused();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  });
}
