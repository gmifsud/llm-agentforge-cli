'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { createDashboard } = require('../dashboard/server/http');
const { WriteService } = require('../dashboard/server/write-service');
const { ReadService } = require('../dashboard/server/read-service');
const { inspectDestination } = require('../src/infra/fs-inspect');
const { fixture, contentSnapshot } = require('./dashboard-fixtures');
const { makeVault, mkLink } = require('./helpers');

const ok = (svc, change) => { const p = svc.preview(change); assert.equal(p.ok, true, JSON.stringify(p.conflicts)); return p; };
const apply = (svc, ...changes) => svc.apply(changes).results;

test('attach a folder, rebuild, choose a collision winner: library follows, CLI config agrees', t => {
  const f = fixture(t);
  const extra = makeVault(f.root, 'extra', ['sql-review', 'perf']);
  const svc = new WriteService(f.options);

  const attach = ok(svc, { kind: 'source.attach', args: { location: extra, name: 'extra' } });
  assert.ok(attach.lines.some(l => /2 skills found/.test(l.text)));
  assert.ok(attach.lines.some(l => /sql-review/.test(l.text) && l.tone === 'warn'), 'overlap with the vault is called out');

  const rebuild = ok(svc, { kind: 'library.rebuild' });
  assert.ok(rebuild.lines.some(l => /Add 1 skill: sql-review/.test(l.text)), 'diff against the built library before attach');

  const r = apply(svc, { kind: 'source.attach', args: { location: extra, name: 'extra' } }, { kind: 'library.rebuild' });
  assert.deepEqual(r.map(x => x.status), ['applied', 'applied']);
  const lib = path.join(f.homedir, '.agentforge', 'merged-skills');
  assert.deepEqual(fs.readdirSync(lib).sort(), ['browser-testing', 'frontend-design', 'perf', 'sql-review']);
  assert.equal(fs.realpathSync(path.join(lib, 'sql-review')).toLowerCase(), path.join(f.vault, 'sql-review').toLowerCase());

  const pref = apply(svc, { kind: 'library.prefer', args: { skill: 'sql-review', source: 'extra' } }, { kind: 'library.rebuild' });
  assert.deepEqual(pref.map(x => x.status), ['applied', 'applied']);
  assert.equal(fs.realpathSync(path.join(lib, 'sql-review')).toLowerCase(), path.join(extra, 'sql-review').toLowerCase());
  const saved = JSON.parse(fs.readFileSync(path.join(f.homedir, '.agentforge', 'config.json'), 'utf8'));
  assert.equal(saved.vaultRoot, f.vault);
  assert.equal(saved.preferences['sql-review'].source, 'extra');
  assert.deepEqual(Object.keys(saved.preferences['sql-review'].digests).sort(), ['extra', 'vault'], 'the choice is pinned to the content of both copies');
  assert.match(saved.preferences['sql-review'].digests.vault, /^[a-f0-9]{64}$/);

  const reader = new ReadService(f.options);
  const c = reader.refresh();
  assert.equal(c.library.inSync, true);
  const col = c.collisions.find(x => x.name === 'sql-review');
  assert.equal(c.sources.find(s => s.id === col.preferredSourceId).key, 'extra');
  assert.equal(c.sources.find(s => s.id === c.skills.find(s => s.id === col.winnerId).sourceId).key, 'extra');

  apply(svc, { kind: 'library.prefer', args: { skill: 'sql-review' } });
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(f.homedir, '.agentforge', 'config.json'), 'utf8')), { vaultRoot: f.vault });
});

test('add a project, wire two agents to the library, repoint one that pointed elsewhere', t => {
  const f = fixture(t);
  const svc = new WriteService({ ...f.options, projects: [] });
  const proj = path.join(f.root, 'new-app'); fs.mkdirSync(proj);

  apply(svc, { kind: 'project.add', args: { path: proj } });
  const reader = new ReadService({ ...f.options, projects: [] });
  let c = reader.refresh();
  const entry = c.projects.find(p => p.project.path === proj);
  assert.equal(entry.project.origin, 'saved');
  assert.ok(entry.targets.every(x => x.feeds === 'none'));

  const wire = ok(svc, { kind: 'project.wire', args: { projectId: entry.project.id, targets: ['claude', 'gemini'] } });
  assert.ok(wire.lines.some(l => l.text === 'Link .claude/skills to the library'));
  assert.ok(wire.lines.some(l => l.text === 'Write CLAUDE.md'));
  assert.deepEqual(apply(svc, { kind: 'project.wire', args: { projectId: entry.project.id, targets: ['claude', 'gemini'] } }).map(r => r.status), ['applied']);
  c = reader.refresh();
  const wired = c.projects.find(p => p.project.path === proj).targets;
  assert.equal(wired.find(x => x.id === 'claude').feeds, 'library');
  assert.equal(wired.find(x => x.id === 'gemini').feeds, 'library');
  assert.equal(wired.find(x => x.id === 'codex').feeds, 'none');
  assert.match(fs.readFileSync(path.join(proj, '.gitignore'), 'utf8'), /\.claude\/skills/);

  // The fixture project has .claude/skills linked to the vault and .codex/skills linked to an external folder.
  const old = new ReadService(f.options).refresh().projects[0];
  assert.equal(old.targets.find(x => x.id === 'claude').feeds, 'vault');
  assert.equal(old.targets.find(x => x.id === 'codex').feeds, 'elsewhere');
  const svc2 = new WriteService(f.options);
  const refuse = svc2.preview({ kind: 'project.wire', args: { projectId: old.project.id, targets: ['codex'] } });
  assert.equal(refuse.ok, false);
  assert.match(refuse.conflicts[0], /Use Repoint/);
  const before = fs.readdirSync(f.source).sort();
  const repoint = ok(svc2, { kind: 'project.wire', args: { projectId: old.project.id, targets: ['codex'], repoint: true, writeDocs: false } });
  assert.ok(repoint.lines.some(l => l.tone === 'remove' && /That folder is not touched/.test(l.text)));
  assert.deepEqual(apply(svc2, { kind: 'project.wire', args: { projectId: old.project.id, targets: ['codex'], repoint: true, writeDocs: false } }).map(r => r.status), ['applied']);
  assert.deepEqual(fs.readdirSync(f.source).sort(), before, 'the folder the old link pointed at is untouched');
  assert.equal(new ReadService(f.options).refresh().projects[0].targets.find(x => x.id === 'codex').feeds, 'library');
});

test('changes stop at the first refusal; nothing after it runs', t => {
  const f = fixture(t);
  const svc = new WriteService(f.options);
  const before = contentSnapshot(f.root);
  const r = apply(svc,
    { kind: 'source.attach', args: { location: path.join(f.root, 'nope'), name: 'nope' } },
    { kind: 'library.rebuild' });
  assert.deepEqual(r.map(x => x.status), ['refused', 'skipped']);
  assert.deepEqual(contentSnapshot(f.root), before);
  assert.equal(svc.preview({ kind: 'source.attach', args: { location: 'relative\\path' } }).ok, false);
  assert.equal(svc.preview({ kind: 'source.attach', args: { location: f.vault, name: 'v2' } }).ok, false, 'the vault cannot be attached again');
  assert.equal(svc.preview({ kind: 'source.attach', args: { location: path.join(f.homedir, '.agentforge', 'merged-skills'), name: 'lib' } }).ok, false);
  assert.equal(svc.preview({ kind: 'nope.nope' }).ok, false);
  assert.equal(svc.preview({ kind: 'project.wire', args: { projectId: 'x'.repeat(64), targets: ['claude'] } }).ok, false);
  assert.equal(svc.preview({ kind: 'library.prefer', args: { skill: 'browser-testing', source: 'vault' } }).ok, false, 'only one source provides it');
});

test('a session project cannot be forgotten; a saved one can, and its folder is untouched', t => {
  const f = fixture(t);
  const svc = new WriteService(f.options);
  const session = new ReadService(f.options).refresh().projects[0].project;
  assert.equal(svc.preview({ kind: 'project.forget', args: { projectId: session.id } }).ok, false);
  const other = path.join(f.root, 'other'); fs.mkdirSync(other); fs.writeFileSync(path.join(other, 'keep.txt'), 'x');
  apply(svc, { kind: 'project.add', args: { path: other } });
  const saved = new ReadService(f.options).refresh().projects.find(p => p.project.path === other).project;
  assert.deepEqual(apply(svc, { kind: 'project.forget', args: { projectId: saved.id } }).map(r => r.status), ['applied']);
  assert.ok(fs.existsSync(path.join(other, 'keep.txt')));
  assert.equal(new ReadService(f.options).refresh().projects.some(p => p.project.path === other), false);
});

test('verify asks the tool, saves its answer, and the answer goes out of date when the skills change', t => {
  const f = fixture(t);
  const skillsDir = path.join(f.project, '.claude', 'skills');
  const calls = [];
  // Stands in for the agent tool: it answers with every skill it can see in the folder.
  const svc = new WriteService({ ...f.options, verifyRun: (command) => { calls.push(command); return fs.readdirSync(skillsDir).join('\n'); } });
  const project = new ReadService(f.options).refresh().projects[0];
  assert.equal(project.targets.find(x => x.id === 'claude').verification, null, 'never asked yet');
  const change = { kind: 'project.verify', args: { projectId: project.project.id, target: 'claude' } };

  const before = contentSnapshot(f.root);
  const preview = ok(svc, change);
  assert.ok(preview.lines.some(l => l.tone === 'warn' && /Sends one short question/.test(l.text)), 'says a question is sent on the user\'s account');
  assert.ok(preview.lines.some(l => /Nothing in the project changes/.test(l.text)));
  assert.deepEqual(calls, [], 'a preview never runs the tool');
  assert.deepEqual(contentSnapshot(f.root), before, 'a preview writes nothing');

  const unwired = svc.preview({ kind: 'project.verify', args: { projectId: project.project.id, target: 'gemini' } });
  assert.equal(unwired.ok, false);
  assert.match(unwired.conflicts[0], /Wire the agent first/);
  assert.equal(svc.preview({ kind: 'project.verify', args: { projectId: project.project.id, target: 'nope' } }).ok, false);

  const projectBefore = contentSnapshot(f.project);
  assert.deepEqual(apply(svc, change).map(r => r.status), ['applied']);
  assert.deepEqual(calls, ['claude']);
  assert.deepEqual(contentSnapshot(f.project), projectBefore, 'the project itself is untouched');
  let v = new ReadService(f.options).refresh().projects[0].targets.find(x => x.id === 'claude').verification;
  assert.equal(v.level, 'verified');
  assert.equal(v.tool, 'claude');
  assert.equal(v.stale, false);
  assert.equal(v.basis, undefined, 'the internal basis is not sent to the page');

  // The folder the link points at changes: the old answer no longer describes what is there.
  fs.mkdirSync(path.join(f.vault, 'added-later'));
  fs.writeFileSync(path.join(f.vault, 'added-later', 'SKILL.md'), '# Added later\n');
  fs.utimesSync(f.vault, new Date(), new Date(Date.now() + 5000));
  v = new ReadService(f.options).refresh().projects[0].targets.find(x => x.id === 'claude').verification;
  assert.equal(v.level, 'verified');
  assert.equal(v.stale, true);

  // A tool that is not installed is recorded as such, not as a failure of the change.
  const missing = new WriteService({ ...f.options, verifyRun: () => { throw Object.assign(new Error('spawn ENOENT'), { code: 'ENOENT' }); } });
  assert.deepEqual(apply(missing, change).map(r => r.status), ['applied']);
  v = new ReadService(f.options).refresh().projects[0].targets.find(x => x.id === 'claude').verification;
  assert.equal(v.level, 'unavailable');
  assert.match(v.detail, /not installed/);
});

function post(url, route, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const target = new URL(url);
    const data = JSON.stringify(body);
    const req = http.request({ hostname: target.hostname, port: target.port, path: route, method: 'POST', headers: {
      'x-agentforge-read': '1', 'x-agentforge-write': '1', 'content-type': 'application/json', origin: url, ...headers } }, res => {
      let out = ''; res.on('data', c => out += c); res.on('end', () => resolve({ status: res.statusCode, body: out }));
    }); req.on('error', reject); req.end(data);
  });
}

test('HTTP: changes need same Origin, both headers and JSON; previews never write', async t => {
  const f = fixture(t);
  const assetRoot = path.join(f.root, 'ui'); fs.mkdirSync(assetRoot); fs.writeFileSync(path.join(assetRoot, 'index.html'), '<h1>x</h1>');
  const app = await createDashboard({ options: f.options, assetRoot }); t.after(() => app.close());
  const before = contentSnapshot(f.root);
  const change = { kind: 'library.rebuild' };
  for (const headers of [{ origin: 'https://evil.example' }, { origin: '' }, { 'sec-fetch-site': 'cross-site' }, { 'x-agentforge-write': '' }]) {
    assert.equal((await post(app.url, '/api/v1/changes/preview', { change }, headers)).status, 403, JSON.stringify(headers));
  }
  assert.equal((await post(app.url, '/api/v1/changes/preview', { change }, { 'content-type': 'text/plain' })).status, 415);
  assert.equal((await post(app.url, '/api/v1/changes/run', { change })).status, 405);
  const preview = await post(app.url, '/api/v1/changes/preview', { change });
  assert.equal(preview.status, 200);
  assert.equal(JSON.parse(preview.body).ok, true);
  assert.deepEqual(contentSnapshot(f.root), before, 'preview does not write');
  const applied = await post(app.url, '/api/v1/changes/apply', { changes: [change] });
  assert.equal(JSON.parse(applied.body).results[0].status, 'applied');
  assert.equal(inspectDestination(path.join(f.homedir, '.agentforge', 'merged-skills', 'sql-review')).kind, 'link');
});

test('one failing fetch or refused check does not cancel the others; any other failure still stops what follows', t => {
  const f = fixture(t);
  fs.writeFileSync(f.registry, JSON.stringify({ repositories: [...f.repos,
    { name: 'down', type: 'git', url_or_path: 'https://example.com/down.git' },
    { name: 'up', type: 'git', url_or_path: 'https://example.com/up.git' }] }));
  // Stands in for Git: one host cannot be reached, the other clones.
  const git = { clone: (url, dest) => { if (/down/.test(url)) throw new Error('could not resolve host'); fs.mkdirSync(dest, { recursive: true }); }, pull() {}, revision: () => 'abc1234' };
  const svc = new WriteService({ ...f.options, git });

  const fetched = apply(svc, { kind: 'source.fetch', args: { name: 'down' } }, { kind: 'source.fetch', args: { name: 'up' } }, { kind: 'library.rebuild' });
  assert.deepEqual(fetched.map(r => r.status), ['failed', 'applied', 'applied'], 'the unreachable source is reported, the other is fetched, the library is still rebuilt');
  assert.match(fetched[0].lines[0].text, /"down" could not be fetched: could not resolve host/);
  assert.match(fetched[1].lines[0].text, /"up" downloaded at abc1234/);

  // A check that cannot be made (the agent is not wired) is refused for that agent only.
  const project = new ReadService(f.options).refresh().projects[0];
  const asked = [];
  const tool = new WriteService({ ...f.options, verifyRun: (command) => { asked.push(command); return fs.readdirSync(path.join(f.project, '.claude', 'skills')).join('\n'); } });
  const checks = apply(tool,
    { kind: 'project.verify', args: { projectId: project.project.id, target: 'gemini' } },
    { kind: 'project.verify', args: { projectId: project.project.id, target: 'claude' } });
  assert.deepEqual(checks.map(r => r.status), ['refused', 'applied']);
  assert.deepEqual(asked, ['claude'], 'only the agent that could be checked was asked');

  // Every other kind of change keeps the old rule: when one cannot be made, nothing after it runs.
  const stopped = apply(svc, { kind: 'source.detach', args: { name: 'nothing' } }, { kind: 'library.rebuild' });
  assert.deepEqual(stopped.map(r => r.status), ['refused', 'skipped']);
});

test('the rebuild preview and the catalogue say which skills changed content since the last build, even when no link changed', t => {
  const f = fixture(t);
  const svc = new WriteService(f.options);
  assert.equal(new ReadService(f.options).refresh().sinceLastBuild, null, 'no record before the first build');
  apply(svc, { kind: 'library.rebuild' });

  let catalog = new ReadService(f.options).refresh();
  assert.equal(catalog.sinceLastBuild.first, false);
  assert.deepEqual(catalog.sinceLastBuild.changed, []);
  assert.match(catalog.sinceLastBuild.builtAt, /^\d{4}-\d\d-\d\dT/);
  assert.ok(!ok(svc, { kind: 'library.rebuild' }).lines.some(l => /Content changed/.test(l.text)), 'nothing to report yet');

  // A source file is edited. The library is made of links, so nothing about the library on disk differs.
  fs.appendFileSync(path.join(f.vault, 'sql-review', 'SKILL.md'), 'edited\n');
  const before = contentSnapshot(f.root);
  const preview = ok(svc, { kind: 'library.rebuild' });
  assert.deepEqual(contentSnapshot(f.root), before, 'a preview writes nothing, the record included');
  assert.ok(preview.lines.some(l => l.tone === 'change' && /Content changed since the last build in 1 skill: sql-review/.test(l.text)));
  assert.ok(preview.lines.some(l => /Already up to date/.test(l.text)), 'the links are current; only the content moved');
  catalog = new ReadService(f.options).refresh();
  assert.deepEqual(catalog.sinceLastBuild.changed, ['sql-review']);
  assert.equal(catalog.library.inSync, true);

  apply(svc, { kind: 'library.rebuild' });
  assert.deepEqual(new ReadService(f.options).refresh().sinceLastBuild.changed, [], 'once it is built, it is the new record');

  // A damaged record is no record: the board shows nothing, and the next build still works.
  fs.writeFileSync(path.join(f.homedir, '.agentforge', 'lock.json'), '{ nope');
  assert.equal(new ReadService(f.options).refresh().sinceLastBuild, null);
  assert.deepEqual(apply(svc, { kind: 'library.rebuild' }).map(r => r.status), ['applied']);
});

test('the dashboard will not attach a set as a source, and rebuilding the library also builds the sets', t => {
  const f = fixture(t);
  const { createPaths } = require('../src/infra/paths');
  const sets = require('../src/application/sets');
  const { computeLibrary } = require('../src/application/sync');
  const paths = createPaths({ homedir: f.homedir, scriptDir: path.resolve(__dirname, '..') });
  sets.createSet({ paths, name: 'mine', rules: [{ type: 'source', value: 'vault' }], entries: computeLibrary({ paths, env: {} }).view.entries });

  const svc = new WriteService(f.options);
  const attach = svc.preview({ kind: 'source.attach', args: { location: sets.setView(paths, 'mine'), name: 'myset' } });
  assert.equal(attach.ok, false);
  assert.ok(attach.conflicts.some(c => /skill set/.test(c)), JSON.stringify(attach.conflicts));

  // A skill added to the vault reaches the set when the library is rebuilt: nothing is ever stale against the library.
  makeVault(f.root, 'extra-skill-home', ['late-skill']);
  fs.cpSync(path.join(f.root, 'extra-skill-home', 'late-skill'), path.join(f.vault, 'late-skill'), { recursive: true });
  assert.deepEqual(apply(svc, { kind: 'library.rebuild' }).map(r => r.status), ['applied']);
  assert.ok(fs.readdirSync(sets.setView(paths, 'mine')).includes('late-skill'));
});

test('sets in the dashboard: saved, read by an agent, and removed, all as reviewed changes', t => {
  const f = fixture(t);
  const { createPaths } = require('../src/infra/paths');
  const setsApp = require('../src/application/sets');
  const paths = createPaths({ homedir: f.homedir, scriptDir: path.resolve(__dirname, '..') });
  const put = (dir, name, category) => fs.writeFileSync(path.join(dir, name, 'SKILL.md'), `---\nname: ${name}\ndescription: ${name} description\ncategory: ${category}\n---\n# ${name}\n`);
  put(f.vault, 'sql-review', 'data'); put(f.vault, 'frontend-design', 'ui'); put(f.source, 'browser-testing', 'ui');
  const svc = new WriteService(f.options);
  const save = { kind: 'set.save', args: { name: 'ui', rules: [{ type: 'category', value: 'ui' }] } };

  const before = contentSnapshot(f.root);
  const preview = ok(svc, save);
  assert.ok(preview.lines.some(l => /Create the set "ui" with 2 skills/.test(l.text)), JSON.stringify(preview.lines));
  assert.ok(preview.lines.some(l => /Every description fits/.test(l.text)));
  assert.deepEqual(contentSnapshot(f.root), before, 'a preview writes nothing');

  // What cannot be saved is refused with a reason, not saved quietly.
  assert.match(svc.preview({ kind: 'set.save', args: { name: 'x', rules: [{ type: 'skill', value: 'nope' }] } }).conflicts.join(' '), /selects no skill/);
  assert.match(svc.preview({ kind: 'set.save', args: { name: 'x', rules: [{ type: 'skill', value: 'sql-review', exclude: true }] } }).conflicts.join(' '), /at least one rule/);
  assert.equal(svc.preview({ kind: 'set.save', args: { name: 'library', rules: [{ type: 'skill', value: 'sql-review' }] } }).ok, false);
  assert.equal(svc.preview({ kind: 'set.save', args: { name: 'x', rules: [{ type: 'tag', value: 'y' }] } }).ok, false);

  assert.deepEqual(apply(svc, save).map(r => r.status), ['applied']);
  assert.deepEqual(fs.readdirSync(setsApp.setView(paths, 'ui')).sort(), ['browser-testing', 'frontend-design']);
  assert.match(svc.preview(save).conflicts.join(' '), /already exists/, 'an existing set is not replaced by accident');
  const replace = ok(svc, { kind: 'set.save', args: { name: 'ui', replace: true, rules: [...save.args.rules, { type: 'skill', value: 'sql-review' }] } });
  assert.ok(replace.lines.some(l => /Replace the rules of the set "ui": it will hold 3 skills/.test(l.text)), JSON.stringify(replace.lines));

  // The catalogue lists the set, and each skill in the library carries what the editor needs.
  let catalog = new ReadService(f.options).refresh();
  assert.deepEqual(catalog.sets.map(s => [s.name, s.built, s.rules.length]), [['ui', true, 1]]);
  const skill = catalog.skills.find(s => s.name === 'sql-review');
  assert.equal(skill.category, 'data');
  assert.equal(skill.descriptionChars, 'sql-review description'.length);

  // An agent reads the set: its one folder link now points there, and the preview says what is lost.
  const project = catalog.projects[0].project;
  const wire = { kind: 'project.wire', args: { projectId: project.id, targets: ['claude'], writeDocs: false, repoint: true, set: 'ui' } };
  const w = ok(svc, wire);
  assert.ok(w.lines.some(l => /Link \.claude\/skills to the set ui/.test(l.text)), JSON.stringify(w.lines));
  assert.ok(w.lines.some(l => /not available in this project at all/.test(l.text)), JSON.stringify(w.lines));
  assert.equal(svc.preview({ kind: 'project.wire', args: { ...wire.args, set: 'nope' } }).ok, false, 'a set that does not exist cannot be read');
  assert.deepEqual(apply(svc, wire).map(r => r.status), ['applied']);
  const reading = new ReadService(f.options).refresh().projects[0].targets.find(x => x.id === 'claude');
  assert.equal(reading.feeds, 'set');
  assert.equal(reading.set, 'ui');

  // A set that an agent reads cannot be removed until the agent is pointed elsewhere.
  const blocked = svc.preview({ kind: 'set.remove', args: { name: 'ui' } });
  assert.equal(blocked.ok, false);
  assert.match(blocked.conflicts.join(' '), /read by 1 agent/);
  apply(svc, { kind: 'library.rebuild' });
  apply(svc, { kind: 'project.wire', args: { projectId: project.id, targets: ['claude'], writeDocs: false, repoint: true } });
  assert.equal(new ReadService(f.options).refresh().projects[0].targets.find(x => x.id === 'claude').feeds, 'library');
  ok(svc, { kind: 'set.remove', args: { name: 'ui' } });
  assert.deepEqual(apply(svc, { kind: 'set.remove', args: { name: 'ui' } }).map(r => r.status), ['applied']);
  assert.ok(!fs.existsSync(setsApp.setView(paths, 'ui')));
  assert.deepEqual(new ReadService(f.options).refresh().sets, []);
  assert.ok(fs.existsSync(path.join(f.vault, 'sql-review')), 'the skills themselves are untouched');
});

test('a damaged sets file is reported, and does not break the catalogue', t => {
  const f = fixture(t);
  assert.deepEqual(new ReadService(f.options).refresh().sets, [], 'none yet');
  fs.writeFileSync(path.join(f.homedir, '.agentforge', 'sets.json'), '{ nope');
  const catalog = new ReadService(f.options).refresh();
  assert.deepEqual(catalog.sets, []);
  assert.ok(catalog.warnings.some(w => /sets\.json/.test(w)), JSON.stringify(catalog.warnings));
});
