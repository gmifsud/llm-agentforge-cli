'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { createDashboard } = require('../dashboard/server/http');
const { SuggestService, modelFrom } = require('../dashboard/server/suggest-service');
const { API_HEADER, API_HEADER_VALUE, WRITE_HEADER } = require('../dashboard/server/constants');
const { fixture } = require('./dashboard-fixtures');
const { makeVault } = require('./helpers');

const ROUTE = '/api/v1/suggest';
const WRITE_HEADERS = { [API_HEADER]: API_HEADER_VALUE, [WRITE_HEADER]: '1', 'Content-Type': 'application/json' };

function post(app, route, body, headers = WRITE_HEADERS) {
  return new Promise((resolve, reject) => {
    const target = new URL(app.url);
    const req = http.request({ hostname: target.hostname, port: target.port, path: route, method: 'POST', headers: { Origin: app.url, ...headers } }, res => {
      let text = ''; res.on('data', c => text += c); res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(text) }));
    });
    req.on('error', reject); req.end(JSON.stringify(body));
  });
}

/** A claude stand-in: names the copy after the source it is asked about. Never the real CLI. */
function fakeClaude(calls) {
  return (command, args, opts) => {
    calls.push(opts.input);
    const source = /BEGIN OTHER SKILL\.md \(([^)]+)\)/.exec(opts.input)[1];
    return JSON.stringify({ name: `frontend-design-${source}`, description: `Use the ${source} variant.`, difference: `From ${source}` });
  };
}

/** The fixture has frontend-design in the vault and in "frontend-lab"; `more` adds further sources with their own copy. */
async function setup(t, { more = [], gate } = {}) {
  const f = fixture(t);
  const repos = [...f.repos];
  for (const name of more) repos.push({ name, type: 'local', url_or_path: makeVault(f.root, name, ['frontend-design']) });
  fs.writeFileSync(f.registry, JSON.stringify({ repositories: repos }));
  const calls = [], started = { n: 0 };
  const run = fakeClaude(calls);
  const suggesters = [0, 1].map(() => {
    const service = new SuggestService({ ...f.options, run });
    return { async run(operation, args) { started.n++; if (gate) await gate; return service.suggest(args[0], args[1], { fresh: args[2] }); }, async close() {} };
  });
  const assetRoot = path.join(f.root, 'ui'); fs.mkdirSync(assetRoot);
  const app = await createDashboard({ options: f.options, assetRoot, suggesters });
  t.after(() => app.close());
  return { f, app, calls, started };
}
const ask = (app, over = {}) => post(app, ROUTE, { skill: 'frontend-design', main: 'vault', ...over });

test('a suggest request without the write header is refused', async t => {
  const { app, calls } = await setup(t);
  const r = await post(app, ROUTE, { skill: 'frontend-design', main: 'vault' }, { [API_HEADER]: API_HEADER_VALUE, 'Content-Type': 'application/json' });
  assert.equal(r.status, 403);
  assert.equal((await post(app, ROUTE, { skill: 'frontend-design', main: 'vault' }, { [WRITE_HEADER]: '1', 'Content-Type': 'application/json' })).status, 403);
  assert.equal(calls.length, 0);
});

test('one suggestion per distinct other copy, with names unique across them and the library', async t => {
  const { app, calls } = await setup(t, { more: ['team-b'] });
  const r = await ask(app);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.deepEqual(r.body.suggestions.map(s => s.source).sort(), ['frontend-lab', 'team-b']);
  assert.ok(r.body.suggestions.every(s => s.by === 'claude' && s.description && s.difference));
  assert.equal(new Set(r.body.suggestions.map(s => s.name)).size, 2);
  assert.equal(calls.length, 2);
});

test('a copy identical to the main one is not asked about, and a name already kept is not suggested again', async t => {
  const { f, app } = await setup(t);
  const r = await ask(app, { main: 'frontend-lab' });
  assert.deepEqual(r.body.suggestions.map(s => s.source), ['vault']);
  const cfg = path.join(f.homedir, '.agentforge', 'config.json');
  const base = JSON.parse(fs.readFileSync(cfg, 'utf8'));
  fs.writeFileSync(cfg, JSON.stringify({ ...base, kept: [{ name: 'frontend-design-vault', from: { skill: 'frontend-design', source: 'vault' }, description: 'x', digest: null, keptAt: 'now' }] }));
  const again = await ask(app, { main: 'frontend-lab', fresh: true });
  assert.notEqual(again.body.suggestions[0].name, 'frontend-design-vault', 'a kept rule name counts as taken');
});

test('an identical second request is answered from the cache without asking claude', async t => {
  const { f, app, calls } = await setup(t);
  assert.equal((await ask(app)).body.suggestions[0].by, 'claude');
  assert.equal(calls.length, 1);
  const second = await ask(app);
  assert.deepEqual(second.body.suggestions.map(s => s.by), ['cache']);
  assert.equal(calls.length, 1);
  const saved = JSON.parse(fs.readFileSync(path.join(f.homedir, '.agentforge', 'suggestions.json'), 'utf8'));
  assert.match(Object.keys(saved)[0], /^frontend-design\|frontend-lab\|[a-f0-9]{64}\|[a-f0-9]{64}$/i);
  await ask(app, { fresh: true });
  assert.equal(calls.length, 2, 'fresh bypasses the cache');
});

test('a changed copy is a new question', async t => {
  const { f, app, calls } = await setup(t);
  await ask(app);
  fs.appendFileSync(path.join(f.source, 'frontend-design', 'SKILL.md'), '\nMore.\n');
  assert.equal((await ask(app)).body.suggestions[0].by, 'claude');
  assert.equal(calls.length, 2);
});

test('a damaged suggestions.json is treated as empty', async t => {
  const { f, app, calls } = await setup(t);
  fs.writeFileSync(path.join(f.homedir, '.agentforge', 'suggestions.json'), '{ not json');
  const r = await ask(app);
  assert.equal(r.status, 200);
  assert.equal(r.body.suggestions[0].by, 'claude');
  assert.equal(calls.length, 1);
  assert.doesNotThrow(() => JSON.parse(fs.readFileSync(path.join(f.homedir, '.agentforge', 'suggestions.json'), 'utf8')), 'and is replaced by a good one');
});

test('a fallback answer is not cached', async t => {
  const f = fixture(t);
  const service = new SuggestService({ ...f.options, run: () => { throw Object.assign(new Error('spawn claude ENOENT'), { code: 'ENOENT' }); } });
  const first = service.suggest('frontend-design', 'vault');
  assert.equal(first.suggestions[0].by, 'fallback');
  assert.equal(fs.existsSync(path.join(f.homedir, '.agentforge', 'suggestions.json')), false);
});

test('a skill that is not a clash, or a main that is not a candidate, is a bad request', async t => {
  const { app } = await setup(t);
  assert.equal((await ask(app, { skill: 'browser-testing' })).status, 400);
  assert.equal((await ask(app, { main: 'nowhere' })).status, 400);
  assert.equal((await post(app, ROUTE, { skill: 7, main: 'vault' })).status, 400);
});

test('the model comes from config.suggestModel only when it is a plain model name', () => {
  assert.equal(modelFrom({}), 'sonnet');
  assert.equal(modelFrom({ suggestModel: 'opus' }), 'opus');
  assert.equal(modelFrom({ suggestModel: 'claude-opus-4.5' }), 'claude-opus-4.5');
  for (const bad of ['--tools', 'a b', 'x;rm', '', 'a'.repeat(65), 7, null]) assert.equal(modelFrom({ suggestModel: bad }), 'sonnet');
});

test('with both suggesters working a third request is told BUSY, and changes still apply', async t => {
  let release; const gate = new Promise(r => { release = r; });
  const { app, started } = await setup(t, { gate });
  const first = ask(app), second = ask(app);
  for (let i = 0; i < 200 && started.n < 2; i++) await new Promise(r => setTimeout(r, 10));
  assert.equal(started.n, 2);
  const third = await ask(app);
  assert.equal(third.status, 503);
  assert.equal(third.body.error.code, 'BUSY');
  assert.equal(third.body.error.retryable, true);
  const applied = await post(app, '/api/v1/changes/apply', { changes: [{ kind: 'library.rebuild' }] });
  assert.equal(applied.status, 200);
  assert.equal(applied.body.results[0].status, 'applied');
  release();
  assert.deepEqual((await Promise.all([first, second])).map(r => r.status), [200, 200]);
  assert.equal((await ask(app)).status, 200, 'a finished suggester is free again');
});

test('the real suggest worker starts, validates and rejects what it does not know (no model is called)', async t => {
  const { Reader } = require('../dashboard/server/reader');
  const f = fixture(t);
  const reader = new Reader(f.options, { workerFile: path.join(__dirname, '../dashboard/server/suggest-worker.js') });
  t.after(() => reader.close());
  await assert.rejects(reader.run('other', []), { code: 'INVALID_REQUEST' });
  await assert.rejects(reader.run('suggest', ['browser-testing', 'vault']), { code: 'INVALID_REQUEST' });
});
