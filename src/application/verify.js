'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync, spawnSync } = require('node:child_process');
const { randomBytes } = require('node:crypto');
const { TARGETS } = require('../domain/targets');
const { usage, failure } = require('../domain/errors');

/**
 * Does the agent tool actually see the skills wired into a project?
 *
 * "Linked" only proves a folder resolves. This asks the tool itself. Nothing is
 * written: three real skill names from the project's skills folder are put to
 * the tool together with one made-up name. The tool must report the real ones
 * and must NOT report the made-up one (which catches a model that agrees with
 * everything).
 *
 * Levels:
 *   verified     every sampled skill reported, control not reported
 *   partial      some sampled skills reported
 *   not-listed   none reported
 *   unreliable   the made-up name was reported, so the answer cannot be trusted
 *   not-wired    the project has no skills folder for this target
 *   unavailable  the tool is not installed, timed out, or failed to run
 *
 * Gemini lists skills with a plain command (no model call). The others are asked
 * one short question in their non-interactive mode, read-only where the tool
 * offers it. No permission-bypass flags are ever passed.
 */
const TOOLS = Object.freeze({
  claude:      { command: 'claude',       args: (q) => ['-p', q, '--model', 'haiku'], asks: true },
  codex:       { command: 'codex',        args: (q) => ['exec', '--skip-git-repo-check', '-s', 'read-only', q], asks: true },
  gemini:      { command: 'gemini',       args: () => ['skills', 'list'], asks: false },
  cursor:      { command: 'cursor-agent', args: (q, o) => ['-p', ...(o.trustWorkspace ? ['--trust'] : []), q], asks: true },
  antigravity: { command: 'agy',          args: (q) => ['-p', q], asks: true },
});
/** The tool that reads each target's folder. `generic` is shared, so it needs --tool. */
const DEFAULT_TOOL = Object.freeze({ claude: 'claude', codex: 'codex', gemini: 'gemini', cursor: 'cursor', antigravity: 'antigravity', generic: 'codex' });
const SAFE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;
const TIMEOUT_MS = 150000;

function sampleSkills(skillsDir) {
  let names;
  try { names = fs.readdirSync(skillsDir).filter((n) => SAFE_NAME.test(n) && fs.existsSync(path.join(skillsDir, n, 'SKILL.md'))).sort(); }
  catch { return null; }
  if (names.length <= 3) return names;
  return [names[0], names[Math.floor(names.length / 2)], names[names.length - 1]];
}

/** Plain words only, so the question is safe to pass through a Windows command shim. */
function question(names) {
  return `Do not read any files and do not run any commands. From this list reply with only the names that are skills available to you, one per line: ${names.join(', ')}. If none of them are available reply with the single word NONE.`;
}

function verifyTarget({ projectRoot, target, tool, trustWorkspace = false, run = runTool, control = `zz-agentforge-control-${randomBytes(3).toString('hex')}` }) {
  const t = TARGETS[target];
  if (!t) throw usage(`invalid target "${target}"`);
  const toolId = tool || DEFAULT_TOOL[target];
  const spec = TOOLS[toolId];
  if (!spec) throw usage(`unknown tool "${toolId}" (expected ${Object.keys(TOOLS).join(' | ')})`);
  const root = path.resolve(projectRoot);
  const skillsDir = path.join(root, t.dir, 'skills');
  const base = { target, tool: toolId, folder: `${t.dir}/skills`, sampled: [], found: [], control: false, seconds: 0 };

  const sampled = sampleSkills(skillsDir);
  if (sampled === null) return { ...base, level: 'not-wired', detail: `${t.dir}/skills does not exist in this project` };
  if (sampled.length === 0) return { ...base, level: 'not-wired', detail: `${t.dir}/skills holds no skills` };

  const started = Date.now();
  let output;
  try { output = run(spec.command, spec.args(question([...sampled, control]), { trustWorkspace }), { cwd: root, timeoutMs: TIMEOUT_MS }); }
  catch (e) {
    return { ...base, sampled, level: 'unavailable', seconds: Math.round((Date.now() - started) / 1000), detail: e.code === 'ENOENT' ? `${spec.command} is not installed or not on PATH` : e.message };
  }
  const seconds = Math.round((Date.now() - started) / 1000);
  const has = (name) => new RegExp(`(^|[^A-Za-z0-9._-])${name.replace(/[.]/g, '\\.')}([^A-Za-z0-9._-]|$)`, 'm').test(output);
  const found = sampled.filter(has);
  // A listing command prints what it has; it is never asked about the control, so the control cannot appear.
  const controlSeen = spec.asks && has(control);
  const level = controlSeen ? 'unreliable' : found.length === sampled.length ? 'verified' : found.length > 0 ? 'partial' : 'not-listed';
  const detail = {
    verified: `${toolId} reported all ${sampled.length} sampled skills`,
    partial: `${toolId} reported ${found.length} of ${sampled.length} sampled skills`,
    'not-listed': `${toolId} reported none of the sampled skills`,
    unreliable: `${toolId} also claimed a skill that does not exist, so its answer cannot be trusted`,
  }[level];
  return { ...base, sampled, found, control: controlSeen, level, seconds, detail };
}

// ─── running a tool ──────────────────────────────────────────────────────────

/** Find what a command name resolves to. On Windows npm installs .cmd and .ps1 shims that cannot be exec'd directly. */
function resolveCommand(command) {
  if (process.platform !== 'win32') return { kind: 'exe', file: command };
  let lines;
  try { lines = execFileSync('where.exe', [command], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).split(/\r?\n/).filter(Boolean); }
  catch { const e = new Error(`${command} not found`); e.code = 'ENOENT'; throw e; }
  const pick = (ext) => lines.find((l) => l.toLowerCase().endsWith(ext));
  if (pick('.exe')) return { kind: 'exe', file: pick('.exe') };
  if (pick('.ps1')) return { kind: 'ps1', file: pick('.ps1') };
  if (pick('.cmd')) return { kind: 'cmd', file: pick('.cmd') };
  // `where` lists an extensionless npm shim first; its .ps1 or .cmd sibling is the runnable one.
  for (const l of lines) { for (const ext of ['.ps1', '.cmd']) if (fs.existsSync(l + ext)) return { kind: ext.slice(1), file: l + ext }; }
  const e = new Error(`${command} not found`); e.code = 'ENOENT'; throw e;
}

function runTool(command, args, { cwd, timeoutMs }) {
  const resolved = resolveCommand(command);
  const opts = { cwd, encoding: 'utf8', timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024, shell: false, input: '', windowsHide: true };
  let res;
  if (resolved.kind === 'exe') res = spawnSync(resolved.file, args, opts);
  // A PowerShell script takes its arguments as an array through -File: nothing is re-parsed as a command line.
  else if (resolved.kind === 'ps1') res = spawnSync('pwsh', ['-NoProfile', '-NonInteractive', '-File', resolved.file, ...args], opts);
  else {
    // A .cmd shim needs cmd.exe. Arguments are quoted here and limited to plain characters, so nothing can be injected.
    for (const a of args) if (!/^[A-Za-z0-9 .,:_\\/-]*$/.test(a)) throw failure('VERIFY_ARGS', 'an argument has characters that are not safe to pass to a command shim');
    res = spawnSync('cmd.exe', ['/d', '/s', '/c', `"${[`"${resolved.file}"`, ...args.map((a) => `"${a}"`)].join(' ')}"`], { ...opts, windowsVerbatimArguments: true });
  }
  if (res.error) { if (res.error.code === 'ETIMEDOUT') throw failure('VERIFY_TIMEOUT', `${command} did not answer within ${Math.round(timeoutMs / 1000)} seconds`); throw res.error; }
  return `${res.stdout || ''}\n${res.stderr || ''}`;
}

module.exports = { verifyTarget, sampleSkills, question, TOOLS, DEFAULT_TOOL };
