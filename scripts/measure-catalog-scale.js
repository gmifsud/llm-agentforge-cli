'use strict';
// Times one dashboard catalog read at several project counts. Measurement only; writes to a temp folder.
// Usage: node scripts/measure-catalog-scale.js [counts, e.g. 1,50,150,300]
const fs = require('node:fs');
const { ReadService } = require('../dashboard/server/read-service');
const { scaleFixture } = require('../tests/dashboard-scale-fixture');

const counts = (process.argv[2] || '1,50,150,300').split(',').map(Number);
for (const n of counts) {
  const cleanup = [];
  const f = scaleFixture({ after: fn => cleanup.unshift(fn) }, { projects: n });
  const service = new ReadService(f.options);
  const runs = [];
  let catalog;
  for (let i = 0; i < 3; i++) { const t0 = process.hrtime.bigint(); catalog = service.refresh(); runs.push(Number(process.hrtime.bigint() - t0) / 1e6); }
  const bytes = Buffer.byteLength(JSON.stringify(catalog));
  const projectBytes = Buffer.byteLength(JSON.stringify(catalog.projects));
  console.log(`${String(n).padStart(4)} projects | read ms: first ${runs[0].toFixed(0)}, then ${runs.slice(1).map(x => x.toFixed(0)).join(', ')} | payload ${(bytes / 1024).toFixed(0)} KB (projects ${(projectBytes / 1024).toFixed(0)} KB)`);
  for (const fn of cleanup) { try { fn(); } catch { /* temp folder */ } }
}
