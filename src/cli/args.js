'use strict';

const { usage } = require('../domain/errors');

/**
 * One parser for both spellings:
 *   PowerShell style:  init -Path X -Target claude -DryRun -NoPreserve
 *   GNU style:         init --path X --target claude --dry-run --no-preserve
 * Also `--key=value` and `-Key:value`.
 */
const VALUE_OPTIONS = {
  path: 'path', target: 'target', name: 'name', stack: 'stack', owner: 'owner',
  buildcmd: 'build', build: 'build', testcmd: 'test', test: 'test', runcmd: 'run', run: 'run',
  vaultroot: 'vault', vault: 'vault', linktype: 'link', link: 'link', branch: 'branch', tool: 'tool', set: 'set',
};
/** Options that may be given more than once; every value is kept, in order. */
const MULTI_OPTIONS = { include: 'include', exclude: 'exclude' };
const FLAG_OPTIONS = {
  dryrun: 'dryRun', 'dry-run': 'dryRun', force: 'force', preserve: 'preserve',
  nopreserve: 'noPreserve', 'no-preserve': 'noPreserve', json: 'json',
  nofetch: 'noFetch', 'no-fetch': 'noFetch', trustworkspace: 'trustWorkspace', 'trust-workspace': 'trustWorkspace', help: 'help', h: 'help', verbose: 'verbose',
};

function parseArgs(argv) {
  const out = { command: undefined, positional: [], opts: {} };
  const rest = [...argv];

  if (rest.length > 0 && !rest[0].startsWith('-')) out.command = rest.shift();

  while (rest.length > 0) {
    const tok = rest.shift();
    if (tok === '--') { out.positional.push(...rest); break; }
    if (!tok.startsWith('-')) { out.positional.push(tok); continue; }

    let body = tok.replace(/^--?/, '');
    let inlineValue;
    const m = body.match(/^([^=:]+)[=:](.*)$/);
    if (m) { body = m[1]; inlineValue = m[2]; }
    const key = body.toLowerCase();

    if (FLAG_OPTIONS[key]) {
      if (inlineValue !== undefined) {
        const v = inlineValue.toLowerCase();
        out.opts[FLAG_OPTIONS[key]] = !(v === 'false' || v === '0' || v === '$false');
      } else out.opts[FLAG_OPTIONS[key]] = true;
      continue;
    }
    if (MULTI_OPTIONS[key]) {
      const value = inlineValue !== undefined ? inlineValue : rest.shift();
      if (value === undefined) throw usage(`option ${tok} needs a value`);
      out.opts[MULTI_OPTIONS[key]] = [...(out.opts[MULTI_OPTIONS[key]] || []), value];
      continue;
    }
    if (VALUE_OPTIONS[key]) {
      const value = inlineValue !== undefined ? inlineValue : rest.shift();
      if (value === undefined) throw usage(`option ${tok} needs a value`);
      out.opts[VALUE_OPTIONS[key]] = value;
      continue;
    }
    throw usage(`unknown option: ${tok}`);
  }
  return out;
}

module.exports = { parseArgs };
