'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { createDashboard } = require('../dashboard/server/http');
const { Reader } = require('../dashboard/server/reader');
const { ReadService } = require('../dashboard/server/read-service');
const { parse } = require('../dashboard/server/main');
const { API_HEADER, API_HEADER_VALUE } = require('../dashboard/server/constants');
const { fixture, contentSnapshot } = require('./dashboard-fixtures');

async function appFixture(t) {
  const f = fixture(t);
  const assetRoot = path.join(f.root, 'ui'); fs.mkdirSync(assetRoot); fs.writeFileSync(path.join(assetRoot, 'index.html'), '<h1>Fixture</h1>');
  const app = await createDashboard({ options: f.options, assetRoot });
  t.after(() => app.close());
  return { f, app };
}
function request(url, route, headers = {}, method = 'GET') {
  return new Promise((resolve, reject) => {
    const target = new URL(url);
    const req = http.request({ hostname: target.hostname, port: target.port, path: route, method, headers: { [API_HEADER]: API_HEADER_VALUE, ...headers } }, res => {
      let body = ''; res.on('data', c => body += c); res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body }));
    }); req.on('error', reject); req.end();
  });
}
test('dashboard HTTP serves real read routes without managed-data changes', async t => {
  const { f, app } = await appFixture(t), before = contentSnapshot(f.root);
  const context = JSON.parse((await request(app.url, '/api/v1/context')).body);
  const c = JSON.parse((await request(app.url, '/api/v1/catalog')).body);
  assert.ok(c.skills.length);
  const doc = await request(app.url, `/api/v1/skills/${c.skills[0].id}/document?generation=${c.generation}`);
  assert.equal(doc.status, 200); assert.equal(doc.headers['cache-control'], 'no-store');
  assert.equal((await request(app.url, `/api/v1/projects/${context.projects[0].id}`)).status, 200);
  assert.equal((await request(app.url, '/skills')).status, 200);
  assert.deepEqual(contentSnapshot(f.root), before);
});
test('dashboard HTTP refuses mutations, foreign requests, raw paths and unsafe assets', async t => {
  const { app } = await appFixture(t);
  for (const method of ['POST', 'PUT', 'DELETE', 'OPTIONS']) assert.equal((await request(app.url, '/api/v1/catalog', {}, method)).status, 405);
  for (const headers of [{ Host: 'evil.example' }, { Origin: 'https://evil.example' }, { Origin: 'null' }, { 'Sec-Fetch-Site': 'cross-site' }, { [API_HEADER]: '' }]) {
    assert.equal((await request(app.url, '/api/v1/catalog', headers)).status, 403);
  }
  assert.equal((await request(app.url, '/api/v1/catalog?path=C:\\secrets')).status, 400);
  assert.equal((await request(app.url, '/%2e%2e/package.json')).status, 403);
  assert.equal((await request(app.url, '/server/main.js')).status, 404);
  assert.equal((await request(app.url, '/api/v1/fetch')).status, 404);
  assert.equal((await request(app.url, '/api/v1/skills/../../secret')).status, 403);
});
test('HEAD performs no scan; coalesced refresh and busy requests are bounded', async t => {
  let calls = 0;
  const reader = { async run() { calls++; return {}; }, async close() {} };
  const app = await createDashboard({ reader }); t.after(() => app.close());
  assert.equal((await request(app.url, '/api/v1/catalog', {}, 'HEAD')).status, 204);
  assert.equal(calls, 0);
  const f = fixture(t), actual = new Reader(f.options); t.after(() => actual.close());
  const a = actual.run('catalog'), b = actual.run('catalog');
  assert.equal(a, b);
  await assert.rejects(actual.run('context'), { code: 'BUSY' });
  assert.ok((await a).generation);
});
test('worker timeout recovers on next read, and shutdown rejects further jobs', async t => {
  const f = fixture(t);
  const worker = path.join(f.root, 'slow-worker.js');
  fs.writeFileSync(worker, "const {parentPort}=require('node:worker_threads');parentPort.on('message',()=>{});");
  const reader = new Reader(f.options, { workerFile: worker, timeoutMs: 100 }); t.after(() => reader.close());
  await assert.rejects(reader.run('catalog'), { code: 'READ_TIMEOUT', status: 504 });
  reader.workerFile = path.resolve(__dirname, '../dashboard/server/read-worker.js'); reader.timeoutMs = 15000;
  assert.ok((await reader.run('catalog')).skills.length);
  await reader.close(); await assert.rejects(reader.run('context'), { code: 'UNAVAILABLE' });
});
test('dashboard launcher only accepts explicit supported parameters', () => {
  assert.equal(parse(['--project', '.', '--port', '0']).port, 0);
  assert.equal(parse(['--project', '.', '--project', '..']).options.projects.length, 2);
  assert.throws(() => parse(['--execute', 'anything']));
  assert.throws(() => parse(['--project']));
  assert.throws(() => parse(['--vault', '\\\\server\\share']));
});

test('reader discards an idle worker that exits and starts a fresh one', async t => {
  const f = fixture(t), worker = path.join(f.root, 'exiting-worker.js');
  fs.writeFileSync(worker, "const {parentPort}=require('node:worker_threads');parentPort.on('message',()=>{parentPort.postMessage({data:'done'});setTimeout(()=>process.exit(0),30);});");
  const reader = new Reader(f.options, { workerFile: worker }); t.after(() => reader.close());
  assert.equal(await reader.run('context'), 'done');
  await new Promise(resolve => reader.worker.once('exit', resolve));
  assert.equal(reader.worker, null);
  reader.workerFile = path.resolve(__dirname, '../dashboard/server/read-worker.js');
  assert.equal((await reader.run('context')).readOnly, true);
});
test('catalogue benchmark: 1000 candidates, ten local sources, five warm reads', t => {
  const f = fixture(t), repos = [];
  for (let s = 0; s < 10; s++) {
    const root = path.join(f.root, `bench-${s}`); fs.mkdirSync(root);
    for (let i = 0; i < 100; i++) { const dir = path.join(root, `skill-${s}-${i}`); fs.mkdirSync(dir); fs.writeFileSync(path.join(dir, 'SKILL.md'), '# Fixture'); }
    repos.push({ name: `bench-${s}`, type: 'local', url_or_path: root });
  }
  fs.writeFileSync(f.registry, JSON.stringify({ repositories: repos }));
  const reader = new ReadService(f.options); reader.refresh();
  const times = [];
  for (let i = 0; i < 5; i++) { const start = performance.now(); const c = reader.refresh(); times.push(performance.now() - start); assert.equal(c.skills.length, 1002); }
  times.sort((a,b) => a-b); t.diagnostic(`Median catalogue read: ${times[2].toFixed(1)} ms; all: ${times.map(x=>x.toFixed(1)).join(', ')} ms`);
  assert.ok(times[2] < 2000, `median ${times[2]} exceeds 2 seconds`);
});
