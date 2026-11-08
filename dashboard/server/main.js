#!/usr/bin/env node
'use strict';
const { createDashboard } = require('./http');
const { localPath } = require('./read-service');

function parse(argv) {
  const options = { projects: [] }; let port = 0, devOrigin;
  for (let i = 0; i < argv.length; i++) {
    const key = argv[i], value = argv[++i];
    if (!value || value.startsWith('--')) throw new Error(`${key} needs a value.`);
    if (key === '--project') { localPath(value); options.projects.push(value); }
    else if (key === '--vault') { localPath(value); options.vault = value; }
    else if (key === '--port' && /^\d+$/.test(value) && Number(value) <= 65535) port = Number(value);
    else if (key === '--dev-origin') devOrigin = value;
    else throw new Error(`Unknown option: ${key}`);
  }
  if (!options.projects.length) options.projects = [process.cwd()];
  return { options, port, devOrigin };
}
async function main() {
  const app = await createDashboard(parse(process.argv.slice(2)));
  console.log(`Agent Forge read-only dashboard: ${app.url}`);
  console.log('Local reads only. Press Ctrl+C to stop.');
  let closing = false;
  const close = async () => { if (closing) return; closing = true; await app.close(); };
  process.once('SIGINT', close); process.once('SIGTERM', close);
}
if (require.main === module) main().catch(e => { console.error(e.message); process.exitCode = 1; });
module.exports = { parse };
