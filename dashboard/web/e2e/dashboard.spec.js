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
/** The wiring map draws one project at a time; these tests look at the fixture's single project. */
async function openMap(page) {
  const res = await page.request.get(`${app.url}/api/v1/context`, { headers: { 'X-Agentforge-Read': '1' } });
  const { projects } = await res.json();
  await page.goto(`${app.url}/map?project=${projects[0].id}`);
  await expect(page.getByRole('heading', { name: 'Projects', exact: true })).toBeVisible();
}
async function applyAll(page, n) {
  const label = n === 1 ? 'Apply 1 change' : `Apply ${n} changes`;
  await expect(page.getByRole('button', { name: label })).toBeEnabled();
  await page.getByRole('button', { name: label }).click();
  await expect(tray(page)).toContainText(n === 1 ? 'Applied 1 change' : `Applied ${n} changes`);
  await page.getByRole('button', { name: 'Done' }).click();
  await expect(tray(page)).toHaveCount(0);
}

test('the board shows real wiring; a queued change writes nothing until applied', async ({ page }, info) => {
  await openMap(page);
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

test('a change that cannot be made blocks Apply and says why', async ({ page }) => {
  await openMap(page);
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
  await page.screenshot({ path: info.outputPath('fleet-mobile.png'), fullPage: true });
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
  await page.getByRole('link', { name: 'Fleet', exact: true }).click();
  await page.evaluate(() => { document.documentElement.style.zoom = '2'; });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  // The map reflows too: cables give way to text at a narrow width.
  await page.evaluate(() => { document.documentElement.style.zoom = '1'; });
  await openMap(page);
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.getByRole('article', { name: 'project' })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});

test('a name clash is reviewed side by side, and choosing a copy goes through the review sheet', async ({ page }) => {
  await openMap(page);
  const clashes = page.getByRole('article', { name: 'Same name, more than one source' });
  await expect(clashes).toContainText('1 needs a look');
  await expect(clashes).toContainText('frontend-design');
  await clashes.getByRole('link', { name: 'Compare the copies of frontend-design' }).click();
  await expect(page.getByRole('heading', { name: 'frontend-design', exact: true })).toBeVisible();
  await expect(page.getByRole('article', { name: 'Your vault, in use' })).toContainText('In use: higher in the default order');
  await expect(page.getByRole('heading', { name: 'What differs' })).toBeVisible();
  await expect(page.getByRole('table').first()).toContainText('frontend-design from vault');
  const before = contentSnapshot(f.root);
  await page.getByRole('button', { name: 'Use the frontend-design from frontend-lab' }).click();
  await expect(tray(page)).toContainText('Use the frontend-design from frontend-lab in the library');
  expect(contentSnapshot(f.root)).toEqual(before);
  await expect(page.getByRole('article', { name: 'frontend-lab' })).toContainText('Will be used when you apply your changes');
  await applyAll(page, 2);
  await expect(page.getByRole('article', { name: 'frontend-lab, in use' })).toContainText('In use: your choice');
  // A reload lands on the same page: nested routes are served the app shell.
  await page.reload();
  await expect(page.getByRole('article', { name: 'frontend-lab, in use' })).toBeVisible();
  await page.getByRole('link', { name: 'Back to Fleet' }).click();
  await expect(page.getByRole('article', { name: 'Same name, more than one source' })).toContainText('1 decided');
});

test('moving a source up previews which skills switch, and applies as one reviewed change', async ({ page }) => {
  await openMap(page);
  const lab = page.getByRole('article', { name: 'frontend-lab, 2 skills' });
  await expect(lab.getByLabel('Position 2')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Move Your vault up' })).toBeDisabled();
  await page.getByRole('button', { name: 'Move frontend-lab up' }).click();
  await expect(tray(page)).toContainText('1 skill switch to frontend-lab: frontend-design');
  await expect(tray(page)).toContainText('Your vault is no longer first');
  await expect(lab.getByLabel('Position 1')).toBeVisible();
  // Moving it back replaces the queued reorder; there is never more than one.
  await page.getByRole('button', { name: 'Move frontend-lab down' }).click();
  await expect(tray(page).getByText('Set source order')).toHaveCount(1);
  await page.getByRole('button', { name: 'Move frontend-lab up' }).click();
  await applyAll(page, 2);
  await expect(page.getByRole('article', { name: 'frontend-lab, 2 skills' }).getByLabel('Position 1')).toBeVisible();
  expect(fs.realpathSync(path.join(f.homedir, '.agentforge', 'merged-skills', 'frontend-design')).toLowerCase()).toBe(path.join(f.source, 'frontend-design').toLowerCase());
  await expect(page.getByRole('article', { name: 'Same name, more than one source' })).toContainText('1 decided');
});

test('library health is visible: the listing budget, rule problems, and where to see them', async ({ page }) => {
  await openMap(page);
  fs.writeFileSync(path.join(f.homedir, '.agentforge', 'config.json'), JSON.stringify({ vaultRoot: f.vault, listingBudgetChars: 30 }));
  fs.writeFileSync(path.join(f.vault, 'sql-review', 'SKILL.md'), '---\nname: something-else\ndescription: Review SQL\n---\n');
  await page.getByRole('button', { name: 'Refresh' }).click();
  const library = page.getByRole('article', { name: 'Library', exact: true });
  await expect(library).toContainText('What your agents will see');
  await expect(library).toContainText('descriptions fit');
  // Two: the renamed sql-review, and browser-testing, which this suite writes without frontmatter.
  await expect(library).toContainText('2 skills have problems in some tools');
  await library.getByRole('button', { name: 'Show' }).first().click();
  await expect(page.getByRole('heading', { name: 'Skill library' })).toBeVisible();
  await expect(page.getByRole('status').filter({ hasText: '2 skills' })).toBeVisible();
  await page.getByRole('button', { name: 'sql-review', exact: true }).click();
  await expect(page.getByRole('region', { name: 'Problems' })).toContainText('Cursor, Gemini CLI');
});

test('Antigravity gets a copy; a stale copy says so and is refreshed without losing added skills', async ({ page }) => {
  await openMap(page);
  await page.getByRole('button', { name: 'Rebuild the library' }).click();
  await applyAll(page, 1);
  const project = page.getByRole('article', { name: 'project' });
  await project.getByRole('button', { name: 'Wire agents' }).click();
  await project.getByRole('checkbox', { name: 'Claude Code' }).uncheck();
  await project.getByRole('checkbox', { name: 'Antigravity' }).check();
  await expect(project).toContainText('Antigravity does not follow links');
  await project.getByRole('button', { name: 'Wire', exact: true }).click();
  await expect(tray(page)).toContainText('Copy the library into .agents/skills');
  await page.getByRole('button', { name: 'Apply 1 change' }).click();
  await expect(tray(page)).toContainText('Antigravity: start a new session');
  await page.getByRole('button', { name: 'Done' }).click();
  await expect(project).toContainText('Has a copy of the library, up to date');
  await expect(project).toContainText('Chosen by the agent');

  const copied = path.join(f.project, '.agents', 'skills');
  fs.mkdirSync(path.join(copied, 'mine')); fs.writeFileSync(path.join(copied, 'mine', 'SKILL.md'), 'local');
  fs.appendFileSync(path.join(f.vault, 'sql-review', 'SKILL.md'), 'edited\n');
  await page.getByRole('button', { name: 'Refresh' }).click();
  await expect(project).toContainText('Its copy is out of date');
  await page.getByRole('button', { name: 'Refresh the copy for Antigravity in project' }).click();
  await expect(tray(page)).toContainText('Skills you added there are kept');
  await applyAll(page, 1);
  await expect(project).toContainText('Has a copy of the library, up to date');
  expect(fs.readFileSync(path.join(copied, 'mine', 'SKILL.md'), 'utf8')).toBe('local');
  expect(fs.readFileSync(path.join(copied, 'sql-review', 'SKILL.md'), 'utf8')).toContain('edited');
});

test('Verify previews what will be asked and runs no tool until applied', async ({ page }, info) => {
  await openMap(page);
  await page.getByRole('button', { name: 'Rebuild the library' }).click();
  await applyAll(page, 1);
  await page.getByRole('button', { name: 'Repoint Codex in project to the library' }).click();
  await applyAll(page, 1);
  const project = page.getByRole('article', { name: 'project' });
  await expect(project).toContainText('Linked. Not checked with the tool yet');
  // Claude Code still reads the vault directly, so there is nothing worth checking for it yet.
  await expect(page.getByRole('button', { name: 'Verify Claude Code in project' })).toHaveCount(0);

  const results = path.join(f.homedir, '.agentforge', 'verifications.json');
  await page.getByRole('button', { name: 'Verify Codex in project' }).click();
  await expect(tray(page)).toContainText('Sends one short question to');
  await expect(tray(page)).toContainText('Nothing in the project changes');
  await expect(page.getByRole('button', { name: 'Apply 1 change' })).toBeEnabled();
  await expect(project).toContainText('Will be checked when you apply');
  await expect(page.getByRole('button', { name: 'Verify Codex in project' })).toHaveCount(0);
  expect(fs.existsSync(results)).toBe(false);

  // An answer already on file is shown with its time, and the button gives way to it.
  fs.mkdirSync(path.dirname(results), { recursive: true });
  const { skillsBasis, nameKey } = require('../../server/workspace');
  fs.writeFileSync(results, JSON.stringify({ [nameKey(path.resolve(f.project))]: { codex: { level: 'verified', tool: 'codex', detail: 'codex reported all 3 sampled skills', at: new Date().toISOString(), basis: skillsBasis(path.join(f.project, '.codex')) } } }));
  await page.getByRole('button', { name: 'Discard all' }).click();
  await page.getByRole('button', { name: 'Refresh' }).click();
  await expect(project).toContainText(/Verified \S/);   // followed by the time, in the reader's own date format
  await expect(project.locator('.agent.verified')).toHaveCount(1);
  await project.screenshot({ path: info.outputPath('project-verified.png') });
  await expect(page.getByRole('button', { name: 'Verify Codex in project' })).toHaveCount(0);
});

test('the wiring map draws nothing until one project is chosen in Fleet, and survives a direct load', async ({ page }) => {
  await page.goto(`${app.url}/map`);
  await expect(page).toHaveTitle('Map · agentforge');
  await expect(page.getByText('draws one project, or one folder, at a time')).toBeVisible();
  await expect(page.locator('section.bay')).toHaveCount(0);

  await page.getByRole('link', { name: 'Choose a project or a folder in Fleet' }).click();
  await expect(page).toHaveURL(/\/$/);
  await page.locator('[data-select^="project:"]').first().click();
  await page.getByRole('complementary', { name: 'Details' }).getByRole('link', { name: 'Show wiring' }).click();
  await expect(page).toHaveURL(/\/map\?project=/);
  await expect(page.getByRole('heading', { name: 'Wiring for project' })).toBeVisible();
  await expect(page.getByRole('article', { name: 'project' })).toContainText('Reads your vault only');
  await expect(page.locator('svg.cables path.cable').first()).toBeAttached();

  await page.reload();                                   // a scoped address works when opened directly
  await expect(page.getByRole('article', { name: 'project' })).toContainText('Reads your vault only');
  await expect(page.locator('svg.cables')).toBeAttached();

  // A project that is no longer in the list is said to be gone, not replaced by another.
  await page.goto(`${app.url}/map?project=nothing`);
  await expect(page.getByText('no longer in your list')).toBeVisible();
  await expect(page.locator('section.bay')).toHaveCount(0);
});

test('fleet: sources are listed in priority order and reordering goes through the review sheet', async ({ page }) => {
  await page.goto(`${app.url}/`);
  await expect(page.getByRole('heading', { name: 'Fleet', exact: true })).toBeVisible();
  const rows = page.getByRole('table').first().locator('tbody tr');
  await expect(rows).toHaveCount(2);
  await expect(rows.nth(0)).toContainText('Your vault');
  await expect(rows.nth(1)).toContainText('frontend-lab');
  await expect(rows.nth(1)).toContainText('2 skills');
  await expect(page.getByRole('button', { name: 'Move Your vault up' })).toBeDisabled();

  const before = contentSnapshot(f.root);
  await page.getByRole('button', { name: 'Move frontend-lab up' }).click();
  await expect(tray(page)).toContainText('1 skill switch to frontend-lab: frontend-design');
  await expect(rows.nth(0)).toContainText('frontend-lab');
  expect(contentSnapshot(f.root)).toEqual(before);
  await applyAll(page, 2);
  await expect(rows.nth(0)).toContainText('frontend-lab');
});

test('fleet: search and filters narrow the list, the order is locked while narrowed, and the layout is remembered', async ({ page }) => {
  fs.writeFileSync(f.registry, JSON.stringify({ repositories: [...f.repos, { name: 'team-skills', type: 'git', url_or_path: 'https://example.com/team/skills.git' }] }));
  await page.goto(`${app.url}/`);
  await page.getByRole('button', { name: 'Refresh' }).click();
  const rows = page.getByRole('table').first().locator('tbody tr');
  await expect(rows).toHaveCount(3);
  await expect(page.getByRole('button', { name: /1 not downloaded/ })).toBeEnabled();

  // A count that is a filter.
  await page.getByRole('button', { name: /1 need attention/ }).click();
  await expect(rows).toHaveCount(1);
  await expect(rows.first()).toContainText('team-skills');
  await expect(rows.first()).toContainText('Not downloaded yet');
  await expect(page.getByText('Clear the search and filter to change the order.')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Move team-skills up' })).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Move team-skills down' })).toBeDisabled();

  // Search works with the filter, and Clear undoes both. Position stays the real one, not the row's place in the filter.
  await page.getByRole('button', { name: 'Clear', exact: true }).click();
  await expect(rows).toHaveCount(3);
  await page.getByLabel('Search').fill('FRONTEND');
  await expect(rows).toHaveCount(1);
  await expect(rows.first().getByLabel('Position 2')).toBeVisible();
  await page.getByLabel('Search').fill('nothing like this');
  await expect(page.getByText('No source matches.')).toBeVisible();
  await page.getByRole('button', { name: 'Clear', exact: true }).click();
  await expect(rows).toHaveCount(3);
  await expect(page.getByRole('button', { name: 'Move team-skills up' })).toBeEnabled();

  // Layout: both lists, then sources only; the choice survives a reload.
  await expect(page.getByRole('heading', { name: 'Projects', exact: true })).toBeVisible();
  await page.getByRole('group', { name: 'Layout' }).getByRole('button', { name: 'Sources' }).click();
  await expect(page.getByRole('heading', { name: 'Projects', exact: true })).toHaveCount(0);
  await page.reload();
  await expect(page.getByRole('heading', { name: 'Sources', exact: true })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Projects', exact: true })).toHaveCount(0);
  await expect(page.getByRole('group', { name: 'Layout' }).getByRole('button', { name: 'Sources' })).toHaveAttribute('aria-pressed', 'true');
});

test('fleet: 150 projects are grouped by folder, collapsed to start, searchable and filterable', async ({ page }) => {
  test.setTimeout(60000);
  const { scaleFixture } = require('../../../tests/dashboard-scale-fixture');
  const bigCleanup = [];
  const sf = scaleFixture({ after: fn => bigCleanup.unshift(fn) }, { projects: 150 });
  const big = await createDashboard({ options: sf.options });
  try {
    await page.goto(`${big.url}/`);
    await expect(page.getByRole('button', { name: /^150 projects$/ })).toBeVisible({ timeout: 20000 });
    const groups = page.locator('.group-toggle');
    const projectRows = page.locator('table.projects tbody tr:not(.group-row)');

    // Four folders, collapsed to start because the list is long; each heading says how many it holds.
    await expect(groups).toHaveCount(4);
    await expect(projectRows).toHaveCount(0);
    await expect(groups.filter({ hasText: /repos.LLM/ })).toContainText('38 projects');
    await expect(groups.filter({ hasText: /repos.LLM/ })).toContainText('need attention');
    await expect(groups.filter({ hasText: /repos.Clients/ })).toContainText('37 projects');

    await page.getByRole('button', { name: 'Expand all' }).click();
    await expect(projectRows).toHaveCount(150);
    await page.getByRole('button', { name: 'Collapse all' }).click();
    await expect(projectRows).toHaveCount(0);
    const llm = groups.filter({ hasText: /repos.LLM/ });
    await expect(llm).toHaveAttribute('aria-expanded', 'false');
    await llm.click();
    await expect(llm).toHaveAttribute('aria-expanded', 'true');
    await expect(projectRows).toHaveCount(38);

    // Searching opens every folder with a match, and folders cannot be collapsed over a result.
    await page.getByLabel('Search').fill('project-007');
    await expect(projectRows).toHaveCount(1);
    await expect(projectRows.first()).toContainText('project-007');
    await expect(groups.first()).toBeDisabled();
    await page.getByRole('button', { name: 'Clear', exact: true }).click();
    await expect(projectRows).toHaveCount(38);

    // The counts are filters. The fixture links a third of the projects to the vault only (50), and 75 have an agent not yet verified.
    await expect(page.getByRole('button', { name: /50 projects need attention/ })).toBeVisible();
    await expect(page.getByRole('button', { name: /75 not verified/ })).toBeVisible();
    await page.getByRole('button', { name: /50 projects need attention/ }).click();
    await expect(projectRows).toHaveCount(50);
    await expect(projectRows.first()).toContainText('Reads your vault only');
    await page.getByRole('button', { name: /75 not verified/ }).click();
    await expect(projectRows).toHaveCount(75);
    await expect(projectRows.first()).toContainText(/Not checked/);
    await page.getByRole('button', { name: 'Clear', exact: true }).click();
    await expect(projectRows).toHaveCount(38);
  } finally {
    outbound = outbound.filter(u => !u.startsWith(big.url));
    await big.close(); for (const fn of bigCleanup) await fn();
  }
});

const drawerOf = page => page.getByRole('complementary', { name: 'Details' });

test('fleet: a source opens in the side panel with its actions; Escape returns focus to its row', async ({ page }) => {
  fs.writeFileSync(f.registry, JSON.stringify({ repositories: [...f.repos, { name: 'team-skills', type: 'git', url_or_path: 'https://example.com/team/skills.git' }] }));
  await page.goto(`${app.url}/`);
  await page.getByRole('button', { name: 'Refresh' }).click();
  const drawer = drawerOf(page);
  await expect(drawer).toHaveCount(0);

  const row = page.locator('[data-select^="source:"]').filter({ hasText: 'team-skills' });
  await row.click();
  await expect(drawer.getByRole('heading', { name: 'team-skills' })).toBeFocused();
  await expect(drawer).toContainText('Git repository');
  await expect(drawer).toContainText('https://example.com/team/skills.git');
  await expect(drawer).toContainText('Not downloaded yet');
  await expect(drawer).toContainText('Position 3 of 3');
  await expect(row).toHaveAttribute('aria-current', 'true');

  // Actions only queue changes; nothing is written until Apply.
  const before = contentSnapshot(f.root);
  await drawer.getByRole('button', { name: 'Fetch updates' }).click();
  await expect(drawer).toContainText('Will be fetched');
  await expect(tray(page)).toBeVisible();
  await page.getByRole('button', { name: 'Discard all' }).click();
  await drawer.getByRole('button', { name: 'Detach' }).click();
  await expect(tray(page)).toContainText('Detach team-skills');
  await expect(drawer).toContainText('Will be detached');
  expect(contentSnapshot(f.root)).toEqual(before);
  await page.getByRole('button', { name: 'Discard all' }).click();

  // The panel can move the source in the order, through the same review sheet.
  await drawer.getByRole('button', { name: 'Move team-skills up in the order' }).click();
  await expect(drawer).toContainText('Position 2 of 3');
  await page.getByRole('button', { name: 'Discard all' }).click();

  await drawer.getByRole('button', { name: 'Show its skills' }).click();
  await expect(page).toHaveURL(/\/library$/);
  await expect(page.getByLabel('Source')).not.toHaveValue('');
  await page.goBack();

  await row.click();
  await page.keyboard.press('Escape');
  await expect(drawer).toHaveCount(0);
  await expect(row).toBeFocused();
});

test('fleet: a project opens with its agents and actions, and every action goes through the review sheet', async ({ page }) => {
  await page.goto(`${app.url}/`);
  const row = page.locator('[data-select^="project:"]').first();
  await row.click();
  const drawer = drawerOf(page);
  await expect(drawer.getByRole('heading', { name: 'project', exact: true })).toBeFocused();
  await expect(drawer).toContainText('Reads your vault only');
  await expect(drawer).toContainText('Reads another folder');

  const before = contentSnapshot(f.root);
  await drawer.getByRole('button', { name: 'Repoint Codex in project to the library' }).click();
  await expect(tray(page)).toContainText('That folder is not touched');
  await expect(drawer).toContainText('Will read the library');
  expect(contentSnapshot(f.root)).toEqual(before);
  await applyAll(page, 1);
  await expect(drawer).not.toContainText('Reads another folder');
  await expect(drawer).toContainText('Linked. Not checked with the tool yet');

  await drawer.getByRole('button', { name: 'Verify Codex in project' }).click();
  await expect(tray(page)).toContainText('Sends one short question to');
  await expect(drawer).toContainText('Will be checked when you apply');
  await page.getByRole('button', { name: 'Discard all' }).click();

  await drawer.getByRole('button', { name: 'Wire agents' }).click();
  await drawer.getByLabel('Gemini CLI').check();
  await drawer.getByRole('button', { name: 'Wire', exact: true }).click();
  await expect(tray(page)).toContainText('Link .gemini/skills to the library');
  await expect(drawer).toContainText('Will read the library');
  await page.getByRole('button', { name: 'Discard all' }).click();
  expect(fs.existsSync(path.join(f.project, '.gemini'))).toBe(false);
});

test('fleet: attach a repository and add a project from the side panel; planned ones show in the lists', async ({ page }) => {
  const extra = makeVault(f.root, 'extra', ['perf']);
  await page.goto(`${app.url}/`);
  const drawer = drawerOf(page);

  await page.getByRole('button', { name: 'Attach a repository' }).click();
  await expect(drawer.getByRole('heading', { name: 'Attach a repository' })).toBeFocused();
  await drawer.getByRole('button', { name: 'Cancel' }).click();
  await expect(drawer).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Attach a repository' })).toBeFocused();

  await page.getByRole('button', { name: 'Attach a repository' }).click();
  await drawer.getByLabel('Folder path or Git URL').fill(extra);
  await drawer.getByRole('button', { name: 'Attach', exact: true }).click();
  await expect(tray(page)).toContainText('1 skill found in it');
  await expect(drawer).toHaveCount(0);
  await expect(page.getByText('Will be attached when you apply your changes')).toBeVisible();
  await applyAll(page, 2);
  await expect(page.locator('[data-select^="source:"]').filter({ hasText: 'extra' })).toBeVisible();
  expect(fs.readlinkSync(path.join(f.homedir, '.agentforge', 'merged-skills', 'perf'))).toBeTruthy();

  const folder = path.join(f.root, 'new-app'); fs.mkdirSync(folder);
  await page.getByRole('button', { name: 'Add a project' }).click();
  await drawer.getByLabel('Project folder').fill(folder);
  await drawer.getByRole('button', { name: 'Add', exact: true }).click();
  await expect(page.getByText(/Will be added when you apply your changes: .*new-app/)).toBeVisible();
  await applyAll(page, 1);
  await page.locator('[data-select^="project:"]').filter({ hasText: 'new-app' }).click();
  await expect(drawer).toContainText('No agents read skills here yet.');
  await drawer.getByRole('button', { name: 'Wire agents' }).click();
  await drawer.getByLabel('Gemini CLI').check();
  await drawer.getByRole('button', { name: 'Wire', exact: true }).click();
  await expect(tray(page)).toContainText('Link .gemini/skills to the library');
  await applyAll(page, 1);
  await expect(drawer.locator('.agent.live')).toHaveCount(2);
  expect(fs.existsSync(path.join(folder, 'CLAUDE.md'))).toBe(true);
});

test('fleet: on a narrow screen the side panel takes the place of the lists, and Close brings them back', async ({ page }) => {
  await page.setViewportSize({ width: 620, height: 900 });
  await page.goto(`${app.url}/`);
  const row = page.locator('[data-select^="source:"]').first();
  await expect(row).toBeVisible();
  await row.click();
  await expect(drawerOf(page)).toBeVisible();
  await expect(page.locator('.fleet')).toBeHidden();
  await drawerOf(page).getByRole('button', { name: 'Close details' }).click();
  await expect(page.locator('.fleet')).toBeVisible();
  await expect(row).toBeFocused();
});

test('fleet: ticking Git sources and choosing Fetch selected queues one fetch each and one rebuild, and writes nothing', async ({ page }) => {
  fs.writeFileSync(f.registry, JSON.stringify({ repositories: [...f.repos,
    { name: 'team-skills', type: 'git', url_or_path: 'https://example.com/team/skills.git' },
    { name: 'other-skills', type: 'git', url_or_path: 'https://example.com/other/skills.git' }] }));
  await page.goto(`${app.url}/`);
  await page.getByRole('button', { name: 'Refresh' }).click();
  await expect(page.getByRole('table').first().locator('tbody tr')).toHaveCount(4);
  await expect(page.getByLabel('Selection', { exact: true })).toHaveCount(0);

  // Only Git sources can be ticked: the vault and a plain folder have nothing to fetch.
  await expect(page.getByLabel('Select Your vault')).toHaveCount(0);
  await expect(page.getByLabel('Select frontend-lab')).toHaveCount(0);

  await page.getByLabel('Select team-skills').check();
  await expect(page.getByLabel('Selection', { exact: true })).toContainText('1 source selected');
  await page.getByLabel('Select every Git source showing').check();
  await expect(page.getByLabel('Selection', { exact: true })).toContainText('2 sources selected');
  await expect(page.getByRole('button', { name: 'Fetch selected (2)' })).toBeEnabled();
  await expect(page.getByRole('button', { name: /Verify selected \(0 agents\)/ })).toBeDisabled();

  const before = contentSnapshot(f.root);
  await page.getByRole('button', { name: 'Fetch selected (2)' }).click();
  const steps = tray(page).locator('ol.steps > li.step');
  await expect(steps).toHaveCount(3);                       // two fetches and a single rebuild
  await expect(tray(page)).toContainText('team-skills');
  await expect(tray(page)).toContainText('other-skills');
  // Already waiting in the review sheet, so asking again adds nothing.
  await expect(page.getByRole('button', { name: 'Fetch selected (0)' })).toBeDisabled();
  expect(contentSnapshot(f.root)).toEqual(before);

  await page.getByRole('button', { name: 'Clear selection' }).click();
  await expect(page.getByLabel('Selection', { exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: 'Discard all' }).click();
});

test('fleet: a folder is ticked at once, Verify selected counts the agents it would ask, and out-of-sight selections are said aloud', async ({ page }) => {
  test.setTimeout(120000);
  const { scaleFixture } = require('../../../tests/dashboard-scale-fixture');
  const bigCleanup = [];
  const sf = scaleFixture({ after: fn => bigCleanup.unshift(fn) }, { projects: 150 });
  const big = await createDashboard({ options: sf.options });
  try {
    await page.goto(`${big.url}/`);
    await expect(page.getByRole('button', { name: /^150 projects$/ })).toBeVisible({ timeout: 20000 });
    const bar = page.getByLabel('Selection', { exact: true });
    const projectRows = page.locator('table.projects tbody tr:not(.group-row)');

    // One tick selects a whole folder, even while it is collapsed.
    await page.getByLabel(/Select every project in .*LLM/).check();
    await expect(bar).toContainText('38 projects selected');
    // In this folder every project's Codex reads the library (38 agents) and a third of them Claude Code too (13): 51 to ask.
    await expect(page.getByRole('button', { name: 'Verify selected (51 agents)' })).toBeEnabled();
    await expect(page.getByRole('button', { name: 'Fetch selected (0)' })).toBeDisabled();

    // Clearing one project leaves the folder box half ticked.
    await page.locator('.group-toggle').filter({ hasText: /repos.LLM/ }).click();
    await expect(projectRows).toHaveCount(38);
    await page.getByLabel('Select project-000').uncheck();
    await expect(bar).toContainText('37 projects selected');
    expect(await page.getByLabel(/Select every project in .*LLM/).evaluate(el => el.indeterminate)).toBe(true);

    // Narrow the list so most of the selection is out of sight: the bar says so.
    await page.getByLabel('Search').fill('project-004');
    await expect(projectRows).toHaveCount(1);
    await expect(bar).toContainText('37 projects selected');
    await expect(bar).toContainText('36 not showing');
    await page.getByRole('button', { name: 'Clear', exact: true }).click();

    // 49 checks (51, less the two agents of the cleared project-000) become one reviewed list, once.
    // Nothing runs: Apply is never pressed, because applying would ask real tools.
    await expect(page.getByRole('button', { name: 'Verify selected (49 agents)' })).toBeEnabled();
    await page.getByRole('button', { name: 'Verify selected (49 agents)' }).click();
    const steps = tray(page).locator('ol.steps > li.step');
    await expect(steps).toHaveCount(49);
    await expect(page.getByRole('button', { name: 'Verify selected (0 agents)' })).toBeDisabled();
    await expect(page.getByRole('button', { name: 'Apply 49 changes' })).toBeEnabled({ timeout: 60000 });

    await page.getByRole('button', { name: 'Clear selection' }).click();
    await expect(bar).toHaveCount(0);
    await page.getByRole('button', { name: 'Discard all' }).click();
  } finally {
    outbound = outbound.filter(u => !u.startsWith(big.url));
    await big.close(); for (const fn of bigCleanup) await fn();
  }
});

test('wiring map: a folder of 38 projects is drawn ten at a time, and actions on the map still go through the review sheet', async ({ page }) => {
  test.setTimeout(90000);
  const { scaleFixture } = require('../../../tests/dashboard-scale-fixture');
  const bigCleanup = [];
  const sf = scaleFixture({ after: fn => bigCleanup.unshift(fn) }, { projects: 150 });
  const big = await createDashboard({ options: sf.options });
  try {
    await page.goto(`${big.url}/`);
    await expect(page.getByRole('button', { name: /^150 projects$/ })).toBeVisible({ timeout: 20000 });
    await page.getByRole('link', { name: /Show wiring for .*LLM/ }).click();
    await expect(page).toHaveURL(/\/map\?group=/);
    const group = new URL(page.url()).searchParams.get('group');
    const at = n => `${big.url}/map?group=${encodeURIComponent(group)}&page=${n}`;

    const cards = page.locator('article.module.project');
    await expect(page.getByRole('heading', { name: /Wiring for .*LLM/ })).toBeVisible();
    await expect(page.getByRole('status').filter({ hasText: 'Projects 1 to 10 of 38' })).toBeVisible();
    await expect(cards).toHaveCount(10);
    await expect(cards.first()).toContainText('project-000');
    // Cables for these ten only: the vault into the library (1), Codex to the library for all ten (10),
    // Claude Code to the library for four and to the vault alone for three (7). Never the other 140 projects.
    await expect(page.locator('svg.cables path.cable')).toHaveCount(18);

    await expect(page.getByRole('link', { name: 'Previous 10' })).toHaveCount(0);
    await page.getByRole('link', { name: 'Next 10' }).click();
    await expect(page).toHaveURL(/page=2/);
    await expect(page.getByRole('status').filter({ hasText: 'Projects 11 to 20 of 38' })).toBeVisible();
    await expect(cards).toHaveCount(10);
    await expect(cards.first()).toContainText('project-040');   // this folder holds 000, 004, 008 and so on, so the 11th is 040

    // The last page holds the remaining eight and offers no Next.
    await page.goto(at(4));
    await expect(cards).toHaveCount(8);
    await expect(page.getByRole('link', { name: 'Next 10' })).toHaveCount(0);
    await expect(page.getByRole('link', { name: 'Previous 10' })).toBeVisible();

    // An address asking for a page past the end is brought back inside the folder.
    await page.goto(at(99));
    await expect(page.getByRole('status').filter({ hasText: 'Projects 31 to 38 of 38' })).toBeVisible();

    // Fixing a link from the map queues a change like anywhere else; nothing is written until Apply.
    await page.getByRole('link', { name: 'Previous 10' }).click();
    const card = page.getByRole('article', { name: 'project-088' });
    await expect(card).toBeVisible();
    await card.getByRole('button', { name: 'Repoint Claude Code in project-088 to the library' }).click();
    await expect(tray(page)).toContainText('That folder is not touched');
    await page.getByRole('button', { name: 'Discard all' }).click();
  } finally {
    outbound = outbound.filter(u => !u.startsWith(big.url));
    await big.close(); for (const fn of bigCleanup) await fn();
  }
});

test('Fleet is the home page: an old /fleet bookmark arrives, the menu has no unscoped map, and the library is managed from here', async ({ page }) => {
  await page.goto(`${app.url}/fleet`);
  await expect(page).toHaveURL(/\/$/);
  await expect(page).toHaveTitle('Fleet · agentforge');
  const nav = page.getByRole('navigation', { name: 'Pages' });
  await expect(nav.getByRole('link')).toHaveText(['Fleet', 'Skills']);
  await expect(nav.getByRole('link', { name: 'Fleet' })).toHaveAttribute('aria-current', 'page');

  // The library card is on this page: its state, and Rebuild through the review sheet.
  const library = page.getByRole('article', { name: 'Library' });
  await expect(library).toContainText('Out of date: 1 to add');
  const before = contentSnapshot(f.root);
  await library.getByRole('button', { name: 'Rebuild the library' }).click();
  await expect(tray(page)).toContainText('Add 1 skill: sql-review');
  expect(contentSnapshot(f.root)).toEqual(before);
  await applyAll(page, 1);
  await expect(library).toContainText('Up to date');
  // And the same-name panel, with its link to compare the copies.
  await expect(page.getByRole('article', { name: 'Same name, more than one source' })).toContainText('frontend-design');
});

test('fleet: at a laptop width Both puts the two lists side by side, and the other two layouts show one', async ({ page }) => {
  await page.setViewportSize({ width: 1366, height: 768 });
  await page.goto(`${app.url}/`);
  const sources = page.getByRole('region', { name: 'Sources' });
  const projects = page.getByRole('region', { name: 'Projects' });
  const a = await sources.boundingBox(), b = await projects.boundingBox();
  expect(b.x).toBeGreaterThanOrEqual(a.x + a.width);          // beside, not below
  expect(Math.abs(a.y - b.y)).toBeLessThan(4);                // starting at the same height

  const layout = page.getByRole('group', { name: 'Layout' });
  await layout.getByRole('button', { name: 'Projects' }).click();
  await expect(sources).toHaveCount(0);
  await expect(projects).toBeVisible();
  await layout.getByRole('button', { name: 'Sources' }).click();
  await expect(projects).toHaveCount(0);
  await expect(sources).toBeVisible();
  await layout.getByRole('button', { name: 'Both' }).click();
  await expect(sources).toBeVisible(); await expect(projects).toBeVisible();
});

test('fleet: Fetch all updates queues every Git source and one rebuild; Check all agents is off when no agent is ready to ask', async ({ page }) => {
  fs.writeFileSync(f.registry, JSON.stringify({ repositories: [...f.repos,
    { name: 'team-skills', type: 'git', url_or_path: 'https://example.com/team/skills.git' },
    { name: 'other-skills', type: 'git', url_or_path: 'https://example.com/other/skills.git' }] }));
  await page.goto(`${app.url}/`);
  await page.getByRole('button', { name: 'Refresh' }).click();
  await expect(page.getByRole('button', { name: 'Fetch all updates (2)' })).toBeEnabled();
  // In this workspace no agent reads the library yet, so there is nothing to check.
  await expect(page.getByRole('button', { name: 'Check all agents (0)' })).toBeDisabled();

  const before = contentSnapshot(f.root);
  await page.getByRole('button', { name: 'Fetch all updates (2)' }).click();
  await expect(tray(page).locator('ol.steps > li.step')).toHaveCount(3);       // two fetches and a single rebuild
  await expect(tray(page)).toContainText('The exception is a fetch or a check');
  await expect(page.getByRole('button', { name: 'Fetch all updates (0)' })).toBeDisabled();
  expect(contentSnapshot(f.root)).toEqual(before);
  await page.getByRole('button', { name: 'Discard all' }).click();
});

test('fleet: Check all agents asks for every working agent at once, and a rebuild offers to check the agents it affects', async ({ page }) => {
  test.setTimeout(120000);
  const { scaleFixture } = require('../../../tests/dashboard-scale-fixture');
  const bigCleanup = [];
  const sf = scaleFixture({ after: fn => bigCleanup.unshift(fn) }, { projects: 150 });
  const big = await createDashboard({ options: sf.options });
  try {
    await page.goto(`${big.url}/`);
    // Claude Code reads the library in 50 projects and Codex in 38: 88 agents the tool has not confirmed.
    const all = page.getByRole('button', { name: 'Check all agents (88)' });
    await expect(all).toBeEnabled({ timeout: 20000 });
    await all.click();
    const steps = tray(page).locator('ol.steps > li.step');
    await expect(steps).toHaveCount(88);
    await expect(tray(page)).toContainText('88 checks ask an agent');
    await expect(tray(page)).toContainText('Nothing runs until you press Apply');
    await expect(page.getByRole('button', { name: 'Check all agents (0)' })).toBeDisabled();
    await expect(page.getByRole('button', { name: 'Apply 88 changes' })).toBeEnabled({ timeout: 90000 });
    await page.getByRole('button', { name: 'Discard all' }).click();

    // A rebuild changes what those agents read, so it offers to check them; taking the offer adds them once.
    await page.getByRole('article', { name: 'Library' }).getByRole('button', { name: 'Rebuild the library' }).click();
    await expect(steps).toHaveCount(1);
    await expect(tray(page)).toContainText('Rebuilding the library changes what 88 agents read');
    await tray(page).getByRole('button', { name: 'Add 88 checks to this list' }).click();
    await expect(steps).toHaveCount(89);
    await expect(tray(page).getByRole('button', { name: /^Add \d+ checks/ })).toHaveCount(0);
    await page.getByRole('button', { name: 'Discard all' }).click();
  } finally {
    outbound = outbound.filter(u => !u.startsWith(big.url));
    await big.close(); for (const fn of bigCleanup) await fn();
  }
});
