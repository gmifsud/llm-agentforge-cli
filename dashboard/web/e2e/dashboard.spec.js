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

test('a name clash is reviewed side by side, and choosing a copy goes through the review sheet', async ({ page }) => {
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
  await page.getByRole('link', { name: 'Back to wiring' }).click();
  await expect(page.getByRole('article', { name: 'Same name, more than one source' })).toContainText('1 decided');
});

test('moving a source up previews which skills switch, and applies as one reviewed change', async ({ page }) => {
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
