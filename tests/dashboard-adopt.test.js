'use strict';
/**
 * T31 step 1, server side: the change kinds skill.setaside, skill.restore and project.adopt.
 * Written before the kinds exist. The core (src/application/set-aside.js, adopt.js) is covered by
 * tests/set-aside.test.js and tests/adopt.test.js; these tests cover only what the write service adds:
 * validation, the plain-language preview, re-planning at Apply, and the stop-on-refusal rule.
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { WriteService } = require('../dashboard/server/write-service');
const { readMarker, copyState } = require('../src/deployment/copy-state');
const { fixture, contentSnapshot } = require('./dashboard-fixtures');

const ok = (svc, change) => { const p = svc.preview(change); assert.equal(p.ok, true, JSON.stringify(p.conflicts)); return p; };
const apply = (svc, ...changes) => svc.apply(changes).results;
const has = (preview, tone, pattern) => preview.lines.some(l => l.tone === tone && pattern.test(l.text));
const said = (preview) => JSON.stringify(preview.lines);

/** The fixture library holds frontend-design, sql-review and browser-testing once it is rebuilt. */
function personalWorld(t) {
  const f = fixture(t);
  const personal = path.join(f.homedir, '.claude', 'skills');
  fs.mkdirSync(path.join(personal, 'frontend-design', 'scripts'), { recursive: true });
  fs.writeFileSync(path.join(personal, 'frontend-design', 'SKILL.md'), '---\nname: frontend-design\ndescription: mine\n---\nmy own steps\r\n');
  fs.writeFileSync(path.join(personal, 'frontend-design', 'scripts', 'run.sh'), 'echo mine\n');
  fs.mkdirSync(path.join(personal, 'unrelated'), { recursive: true });
  fs.writeFileSync(path.join(personal, 'unrelated', 'SKILL.md'), '---\nname: unrelated\n---\n');
  const svc = new WriteService(f.options);
  apply(svc, { kind: 'library.rebuild' });
  const heldAt = path.join(f.homedir, '.agentforge', 'set-aside', 'claude', 'frontend-design');
  return { ...f, svc, personal, heldAt, record: `${heldAt}.json` };
}
const setAside = (name = 'frontend-design', tool = 'claude') => ({ kind: 'skill.setaside', args: { tool, name } });
const restore = (name = 'frontend-design', tool = 'claude') => ({ kind: 'skill.restore', args: { tool, name } });

test('set aside: the preview says what moves and that nothing is deleted, and writes nothing', t => {
  const w = personalWorld(t);
  const before = contentSnapshot(w.root);
  const preview = ok(w.svc, setAside());
  assert.ok(has(preview, 'change', /Move .*frontend-design.*set-aside/), said(preview));
  assert.ok(has(preview, 'note', /Nothing is deleted/), said(preview));
  assert.ok(has(preview, 'note', /Restore/), 'says it can be put back');
  assert.deepEqual(contentSnapshot(w.root), before, 'a preview writes nothing');
});

test('set aside: apply moves the personal folder whole, leaves its neighbours, and the library skill is no longer hidden', t => {
  const w = personalWorld(t);
  const mine = contentSnapshot(path.join(w.personal, 'frontend-design'));
  const neighbour = contentSnapshot(path.join(w.personal, 'unrelated'));
  const libraryBefore = contentSnapshot(path.join(w.homedir, '.agentforge', 'merged-skills'));

  assert.deepEqual(apply(w.svc, setAside()).map(r => r.status), ['applied']);
  assert.equal(fs.existsSync(path.join(w.personal, 'frontend-design')), false);
  assert.deepEqual(contentSnapshot(w.heldAt), mine, 'every file arrives byte for byte, line endings included');
  assert.deepEqual(contentSnapshot(path.join(w.personal, 'unrelated')), neighbour);
  assert.deepEqual(contentSnapshot(path.join(w.homedir, '.agentforge', 'merged-skills')), libraryBefore, 'the library is not touched');
  const rec = JSON.parse(fs.readFileSync(w.record, 'utf8'));
  assert.equal(rec.from, path.join(w.personal, 'frontend-design'));
  assert.equal(fs.existsSync(path.join(w.heldAt, 'set-aside.json')), false, 'the moved folder gains no file');
});

test('set aside: refuses what is not a hiding skill, an unknown tool, an unsafe name, a missing folder and a taken destination', t => {
  const w = personalWorld(t);
  const conflicts = (args) => w.svc.preview({ kind: 'skill.setaside', args }).conflicts.join(' | ');
  assert.match(conflicts({ tool: 'claude', name: 'unrelated' }), /does not hide a library skill/);
  assert.match(conflicts({ tool: 'nope', name: 'frontend-design' }), /Unknown tool/);
  for (const name of ['../x', 'a/b', 'a\\b', '..', '.']) assert.equal(w.svc.preview(setAside(name)).ok, false, name);
  assert.equal(w.svc.preview({ kind: 'skill.setaside', args: { tool: 'claude' } }).ok, false, 'a name is required');
  assert.equal(w.svc.preview({ kind: 'skill.setaside', args: { name: 'frontend-design' } }).ok, false, 'a tool is required');
  assert.match(conflicts({ tool: 'claude', name: 'sql-review' }), /No personal claude skill called "sql-review"/);

  apply(w.svc, setAside());
  fs.mkdirSync(path.join(w.personal, 'frontend-design'));
  fs.writeFileSync(path.join(w.personal, 'frontend-design', 'SKILL.md'), 'a second personal copy');
  assert.match(conflicts({ tool: 'claude', name: 'frontend-design' }), /already holds a set-aside frontend-design/, 'the earlier one is never overwritten');
});

test('set aside: Apply plans again, so a destination that appeared after the preview is refused and nothing moves', t => {
  const w = personalWorld(t);
  ok(w.svc, setAside());
  fs.mkdirSync(w.heldAt, { recursive: true });
  const r = apply(w.svc, setAside());
  assert.deepEqual(r.map(x => x.status), ['refused']);
  assert.match(r[0].message, /already holds a set-aside/);
  assert.ok(fs.existsSync(path.join(w.personal, 'frontend-design', 'SKILL.md')), 'the personal copy stayed where it was');
  assert.equal(fs.existsSync(w.record), false, 'no record is left for a move that did not happen');
});

test('restore: previewed, puts the folder back exactly, removes its record, and refuses when something sits there now', t => {
  const w = personalWorld(t);
  const mine = contentSnapshot(path.join(w.personal, 'frontend-design'));
  assert.equal(w.svc.preview(restore()).ok, false, 'nothing is set aside yet');
  assert.match(w.svc.preview(restore()).conflicts.join(' '), /Nothing is set aside as frontend-design for claude/);
  apply(w.svc, setAside());

  const before = contentSnapshot(w.root);
  const preview = ok(w.svc, restore());
  assert.ok(has(preview, 'change', /Move .*frontend-design.* back/), said(preview));
  assert.ok(has(preview, 'note', /Nothing is deleted/), said(preview));
  assert.deepEqual(contentSnapshot(w.root), before, 'a preview writes nothing');

  fs.mkdirSync(path.join(w.personal, 'frontend-design'));
  const blocked = w.svc.preview(restore());
  assert.equal(blocked.ok, false);
  assert.match(blocked.conflicts.join(' '), /already a skill at/);
  fs.rmdirSync(path.join(w.personal, 'frontend-design'));

  assert.deepEqual(apply(w.svc, restore()).map(r => r.status), ['applied']);
  assert.deepEqual(contentSnapshot(path.join(w.personal, 'frontend-design')), mine, 'back exactly as it was');
  assert.equal(fs.existsSync(w.record), false, 'the record goes with the move');
  assert.equal(fs.existsSync(w.heldAt), false);
});

test('restore: a tampered record cannot send the folder anywhere but the place worked out from the tool and name', t => {
  const w = personalWorld(t);
  apply(w.svc, setAside());
  const rec = JSON.parse(fs.readFileSync(w.record, 'utf8'));
  const elsewhere = path.join(w.root, 'elsewhere', 'frontend-design');
  fs.writeFileSync(w.record, JSON.stringify({ ...rec, from: elsewhere }));
  assert.deepEqual(apply(w.svc, restore()).map(r => r.status), ['applied']);
  assert.ok(fs.existsSync(path.join(w.personal, 'frontend-design', 'SKILL.md')));
  assert.equal(fs.existsSync(path.dirname(elsewhere)), false, 'nothing was written where the record pointed');
});

test('set aside and restore are one-after-another changes: a refusal stops what follows', t => {
  const w = personalWorld(t);
  const r = apply(w.svc, setAside('unrelated'), { kind: 'library.rebuild' });
  assert.deepEqual(r.map(x => x.status), ['refused', 'skipped']);
  assert.match(r[0].message, /does not hide a library skill/, 'refused for the real reason, not as an unknown kind');
  assert.ok(fs.existsSync(path.join(w.personal, 'unrelated', 'SKILL.md')));
});

// ─── adopt ───────────────────────────────────────────────────────────────────

/** A project whose .claude/skills is a real folder of the owner's own skills: "not managed here". */
function adoptWorld(t) {
  const f = fixture(t);
  const project = path.join(f.root, 'unmanaged');
  const folder = path.join(project, '.claude', 'skills');
  fs.mkdirSync(path.join(folder, 'mine'), { recursive: true });
  fs.writeFileSync(path.join(folder, 'mine', 'SKILL.md'), '---\nname: mine\n---\nonly here\r\n');
  fs.mkdirSync(path.join(folder, 'frontend-design'));
  fs.writeFileSync(path.join(folder, 'frontend-design', 'SKILL.md'), '---\nname: frontend-design\n---\nmy version\n');
  fs.writeFileSync(path.join(folder, 'notes.txt'), 'not a skill\n');
  fs.writeFileSync(path.join(project, '.gitignore'), 'node_modules\n');
  const svc = new WriteService({ ...f.options, projects: [f.project, project] });
  apply(svc, { kind: 'library.rebuild' });
  const id = svc.projects().find(p => p.path === project).id;
  const wiredId = svc.projects().find(p => p.path === f.project).id;   // its .claude/skills is a link to the vault
  return { ...f, svc, project, folder, id, wiredId, adopt: { kind: 'project.adopt', args: { projectId: id, target: 'claude' } } };
}

test('adopt: the preview lists what stays yours, what is shared, what is added, warns about untracked files, and writes nothing', t => {
  const w = adoptWorld(t);
  const before = contentSnapshot(w.root);
  const preview = ok(w.svc, w.adopt);
  assert.ok(has(preview, 'add', /Copy 2 missing skills into \.claude\/skills/), said(preview));
  assert.ok(has(preview, 'note', /Your own skills stay as they are: mine/), said(preview));
  assert.ok(has(preview, 'note', /frontend-design.*yours is kept/), 'a same-named skill stays yours and the library one is not copied');
  assert.ok(has(preview, 'note', /Nothing .*deleted/), said(preview));
  assert.ok(has(preview, 'warn', /untracked/i), 'the copied folders will show in git, and the preview says so');
  assert.deepEqual(contentSnapshot(w.root), before, 'a preview writes nothing');
});

test('adopt: apply keeps every file you own byte for byte, records only what it added, and never ignores your skills folder', t => {
  const w = adoptWorld(t);
  const mine = contentSnapshot(path.join(w.folder, 'mine'));
  const shared = contentSnapshot(path.join(w.folder, 'frontend-design'));

  assert.deepEqual(apply(w.svc, w.adopt).map(r => r.status), ['applied']);
  assert.deepEqual(contentSnapshot(path.join(w.folder, 'mine')), mine);
  assert.deepEqual(contentSnapshot(path.join(w.folder, 'frontend-design')), shared, 'your own frontend-design was not replaced');
  assert.equal(fs.readFileSync(path.join(w.folder, 'notes.txt'), 'utf8'), 'not a skill\n');
  assert.deepEqual(fs.readdirSync(w.folder).sort(), ['browser-testing', 'frontend-design', 'mine', 'notes.txt', 'sql-review']);

  const dotDir = path.join(w.project, '.claude');
  assert.deepEqual(readMarker(dotDir).names, ['browser-testing', 'sql-review'], 'the record names what Agentforge added and nothing of yours');
  assert.equal(copyState(dotDir, path.join(w.homedir, '.agentforge', 'merged-skills')).state, 'fresh');
  const ignore = fs.readFileSync(path.join(w.project, '.gitignore'), 'utf8');
  assert.match(ignore, /\.claude\/\.agentforge-skills\.json/);
  assert.doesNotMatch(ignore, /\.claude\/skills/, 'skills of your own that you commit are never hidden from git');
});

test('adopt: once adopted the folder is managed, so a second adopt is refused with the way forward', t => {
  const w = adoptWorld(t);
  apply(w.svc, w.adopt);
  const again = w.svc.preview(w.adopt);
  assert.equal(again.ok, false);
  assert.match(again.conflicts.join(' '), /already managed here/);
  assert.match(again.conflicts.join(' '), /Refresh copy/);
});

test('adopt: refuses a linked folder, a missing folder, an unknown agent, an unknown project, and a library that is not built', t => {
  const w = adoptWorld(t);
  const refuse = (args) => w.svc.preview({ kind: 'project.adopt', args });
  assert.match(refuse({ projectId: w.wiredId, target: 'claude' }).conflicts.join(' '), /not an ordinary folder/, 'a folder that is already a link is managed, not adoptable');
  assert.match(refuse({ projectId: w.id, target: 'gemini' }).conflicts.join(' '), /no skills folder/i);
  assert.equal(refuse({ projectId: w.id, target: 'nope' }).ok, false);
  assert.equal(refuse({ projectId: w.id }).ok, false, 'an agent is required');
  assert.equal(refuse({ projectId: 'x'.repeat(64), target: 'claude' }).ok, false);

  fs.rmSync(path.join(w.homedir, '.agentforge', 'merged-skills'), { recursive: true, force: true });
  assert.match(refuse({ projectId: w.id, target: 'claude' }).conflicts.join(' '), /library .*not been built/i);
});

test('adopt: Apply plans again, so a name that arrives after the preview is yours and is neither copied over nor recorded as ours', t => {
  const w = adoptWorld(t);
  ok(w.svc, w.adopt);
  fs.mkdirSync(path.join(w.folder, 'sql-review'));
  fs.writeFileSync(path.join(w.folder, 'sql-review', 'SKILL.md'), 'arrived late and is mine');
  assert.deepEqual(apply(w.svc, w.adopt).map(r => r.status), ['applied']);
  assert.equal(fs.readFileSync(path.join(w.folder, 'sql-review', 'SKILL.md'), 'utf8'), 'arrived late and is mine');
  assert.deepEqual(readMarker(path.join(w.project, '.claude')).names, ['browser-testing']);
});
