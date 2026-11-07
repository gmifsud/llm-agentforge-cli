#!/usr/bin/env node
'use strict';
/**
 * Compatibility shim: `node repo.js <add|remove|list|fetch|sync> ...`
 * is the same as `agentforge repo ...`. Kept so existing shell aliases and the
 * gd-tool-harness manifest keep working. The implementation is in src/.
 */
const { run } = require('./src/cli/main');
process.exitCode = run(['repo', ...process.argv.slice(2)]);
