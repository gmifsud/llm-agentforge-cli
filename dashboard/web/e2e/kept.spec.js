const { test, expect } = require('@playwright/test');
const fs = require('node:fs');
const path = require('node:path');
const { fixture } = require('../../../tests/dashboard-fixtures');
const { createDashboard } = require('../../server/http');

/** Two clashes: frontend-design (vault and frontend-lab) and sql-review (vault and a second copy added here). */
let f, app, cleanup, outbound, errors;
test.beforeEach(async ({ page }) => {
  cleanup = []; outbound = []; errors = [];
  f = fixture({ after: fn => cleanup.unshift(fn) });
  fs.mkdirSync(path.join(f.source, 'sql-review'));
  fs.writeFileSync(path.join(f.source, 'sql-review', 'SKILL.md'), '---\nname: sql-review\ndescription: sql-review from source\n---\n# sql-review\n');
  app = await createDashboard({ options: f.options });
  page.on('request', req => { if (!req.url().startsWith(app.url)) outbound.push(req.url()); });
  page.on('pageerror', error => errors.push(error.message));
});
test.afterEach(async () => {
  expect(outbound).toEqual([]); expect(errors).toEqual([]);
  await app?.close(); for (const fn of cleanup) await fn();
});

test('suggested names are edited, approved for two clashes and applied once; both copies are kept', async ({ page }) => {
  // Claude is never called: the suggest route is answered here. It is keyed by the clash being asked about.
  const asked = [];
  await page.route('**/api/v1/suggest', async route => {
    const { skill } = route.request().postDataJSON(); asked.push(skill);
    await route.fulfill({ json: { suggestions: [{ source: 'frontend-lab', name: `${skill}-lab`, description: `The ${skill} copy from the lab.`, difference: 'the lab copy is newer', by: 'claude' }] } });
  });
  await page.goto(`${app.url}/library`);
  await page.getByRole('button', { name: /^Name clashes/ }).click();
  const queue = page.getByRole('region', { name: 'Name clashes' });
  await expect(queue).toContainText('2 to decide');

  await queue.getByRole('button', { name: 'Suggest names for 2' }).click();
  await queue.getByRole('group', { name: 'Confirm suggestions' }).getByRole('button', { name: 'Suggest names' }).click();
  await expect(queue).toContainText('2 of 2 clashes suggested');
  expect(asked.sort()).toEqual(['frontend-design', 'sql-review']);

  // Suggestions fill the fields; the person's own edit wins.
  const frontend = queue.getByRole('article', { name: 'Name clash: frontend-design' });
  const sql = queue.getByRole('article', { name: 'Name clash: sql-review' });
  await expect(frontend.getByLabel('Keep as')).toHaveValue('frontend-design-lab');
  await expect(frontend).toContainText('suggested by Claude');
  await sql.getByLabel('Keep as').fill('sql-review-lab-edit');
  await expect(sql).toContainText('typed by you');

  await frontend.getByRole('button', { name: 'Approve' }).click();
  await sql.getByRole('button', { name: 'Approve' }).click();
  await expect(frontend).toContainText('Will be kept when you apply');
  await expect(sql).toContainText('Will be kept when you apply');
  const kept = path.join(f.homedir, '.agentforge', 'kept');
  expect(fs.existsSync(kept)).toBe(false); // nothing is written until Apply

  await page.locator('#changes-control').click();
  await page.getByRole('button', { name: /^Apply \d+ changes?/ }).click();
  await expect(page.locator('dialog.tray:has(ol.steps)')).toContainText(/Applied \d+ changes?/);
  await page.getByRole('button', { name: 'Done' }).click();

  // On disk: two rules, and a rewritten copy for each.
  const config = JSON.parse(fs.readFileSync(path.join(f.homedir, '.agentforge', 'config.json'), 'utf8'));
  expect(config.kept.map(k => k.name).sort()).toEqual(['frontend-design-lab', 'sql-review-lab-edit']);
  for (const name of ['frontend-design-lab', 'sql-review-lab-edit']) {
    expect(fs.readFileSync(path.join(kept, name, 'SKILL.md'), 'utf8')).toContain(`name: ${name}`);
  }

  // On the page: both clashes read as resolved, and the Skills list shows both kept names with their tag.
  await expect(queue).toContainText('0 to decide · 2 resolved');
  await queue.getByRole('button', { name: /Show resolved/ }).click();
  await expect(queue.getByRole('article', { name: 'Name clash: frontend-design' })).toContainText('Kept as frontend-design-lab');
  await expect(queue.getByRole('article', { name: 'Name clash: sql-review' })).toContainText('Kept as sql-review-lab-edit');
  await page.getByRole('button', { name: 'Everything found' }).click();
  for (const [name, from] of [['frontend-design-lab', 'frontend-design'], ['sql-review-lab-edit', 'sql-review']]) {
    const row = page.getByRole('row').filter({ has: page.getByRole('button', { name, exact: true }) });
    await expect(row).toContainText(`kept copy of ${from}`);
  }
});
