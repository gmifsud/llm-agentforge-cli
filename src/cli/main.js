#!/usr/bin/env node
'use strict';

const path = require('node:path');
const os = require('node:os');
const { parseArgs } = require('./args');
const { AgentforgeError } = require('../domain/errors');
const { createPaths, loadConfig, resolveDeployRoot } = require('../infra/paths');
const { createGit } = require('../infra/git');
const { buildVars, planProject, inspectProject } = require('../application/project');
const { inspectLibrary } = require('../application/health');
const { verifyTarget } = require('../application/verify');
const { applyPlan, describeAction } = require('../deployment/apply');
const { addSource, removeSource, listSources, fetchSources } = require('../application/sources');
const { syncView } = require('../application/sync');

const HELP = `agentforge — bootstrap a repo with a token-optimised CLAUDE.md / AGENTS.md / GEMINI.md
and a junction/symlink to the shared skill vault. Idempotent. Non-destructive unless --force.

Usage:
  agentforge init   [--path P] [--target claude|codex|generic|gemini|cursor|antigravity|all] [--name N] [--stack S]
                    [--owner O] [--build C] [--test C] [--run C] [--vault V]
                    [--link junction|symlink|copy|none|auto] [--dry-run] [--force] [--no-preserve]
  agentforge link   [--path P] [--target T] [--vault V] [--link L] [--dry-run] [--force] [--no-preserve]
  agentforge doctor [--path P] [--vault V] [--json]
  agentforge verify [--path P] [--target T] [--tool claude|codex|gemini|cursor|antigravity] [--json]
                                             ask the agent tool itself whether it sees the wired skills
  agentforge repo add <url-or-path> [--name ID] [--branch B]
  agentforge repo remove <ID>
  agentforge repo list [--json]
  agentforge repo fetch [ID]                 clone / fast-forward git sources; never touches the view
  agentforge repo sync [--vault V] [--force] [--no-fetch] [--dry-run]
                                             fetch, then rebuild ~/.agentforge/merged-skills (staged swap)
  agentforge help

PowerShell spelling is accepted too: -Path, -Target, -DryRun, -NoPreserve, -VaultRoot, -LinkType.

Exit codes: 0 ok · 1 failure · 2 usage · 3 refused (conflict or safety boundary; nothing applied)

Vault root for init/link: --vault > AGENTFORGE_VAULT_ROOT > ~/.agentforge/config.json vaultRoot
  > ~/.agentforge/merged-skills (only when repos.json exists) > platform default.
`;

function createLogger(stream, { color }) {
  const c = (code) => (s) => (color ? `\x1b[${code}m${s}\x1b[0m` : s);
  const cyan = c(36), green = c(32), yellow = c(33), red = c(31), grey = c(90);
  const w = (s) => stream.write(s + '\n');
  return {
    step: (m) => w(cyan(`→ ${m}`)),
    ok: (m) => w(green(`✓ ${m}`)),
    warn: (m) => w(yellow(`! ${m}`)),
    err: (m) => w(red(`✗ ${m}`)),
    dry: (m) => w(grey(`(dry) ${m}`)),
    info: (m) => w(`  ${m}`),
    grey: (m) => w(grey(`  ${m}`)),
    raw: w,
  };
}

/**
 * Entry point. Everything environment-specific is injected so tests can run
 * the whole CLI against a temp home. Returns the exit code; never exits.
 */
function run(argv, {
  env = process.env,
  homedir = os.homedir(),
  platform = process.platform,
  scriptDir = path.resolve(__dirname, '..', '..'),
  stdout = process.stdout,
  stderr = process.stderr,
  cwd = process.cwd(),
  git,
} = {}) {
  const log = createLogger(stdout, { color: Boolean(stdout.isTTY) && !env.NO_COLOR });
  const elog = createLogger(stderr, { color: Boolean(stderr.isTTY) && !env.NO_COLOR });
  const paths = createPaths({ homedir, platform, scriptDir });
  const gitClient = git || createGit();

  let parsed;
  try { parsed = parseArgs(argv); } catch (e) { elog.err(e.message); stdout.write(HELP); return e.exitCode || 2; }
  const { command, positional, opts } = parsed;

  if (!command || command === 'help' || opts.help) { stdout.write(HELP); return 0; }

  try {
    switch (command) {
      case 'init':
      case 'link':
        return cmdProject(command, { paths, env, platform, cwd, opts, log, elog });
      case 'doctor':
        return cmdDoctor({ paths, env, cwd, opts, log, elog, stdout });
      case 'verify':
        return cmdVerify({ cwd, opts, log, elog, stdout });
      case 'repo':
        return cmdRepo(positional, { paths, env, opts, log, elog, stdout, git: gitClient });
      default:
        elog.err(`unknown command: ${command}`);
        stdout.write(HELP);
        return 2;
    }
  } catch (e) {
    if (e instanceof AgentforgeError) {
      elog.err(e.message);
      if (Array.isArray(e.details)) for (const d of e.details) elog.info(`${d.path || ''} ${d.reason || JSON.stringify(d)}`.trim());
      return e.exitCode;
    }
    elog.err(e && e.stack ? e.stack : String(e));
    return 1;
  }
}

// ─── init / link ─────────────────────────────────────────────────────────────

function cmdProject(command, { paths, env, platform, cwd, opts, log, elog }) {
  const projectRoot = path.resolve(cwd, opts.path || '.');
  const config = loadConfig(paths);
  const { root: vaultRoot, origin, warnings } = resolveDeployRoot({ cliVault: opts.vault, env, paths, config });
  const preserve = opts.noPreserve ? false : true;
  const dryRun = Boolean(opts.dryRun);
  const vars = buildVars({ projectRoot, name: opts.name, stack: opts.stack, owner: opts.owner, build: opts.build, test: opts.test, run: opts.run, env });

  log.step(`agentforge ${command}`);
  log.info(`Project : ${vars.PROJECT_NAME} (${projectRoot})`);
  log.info(`Target  : ${opts.target || 'claude'}`);
  log.info(`Vault   : ${vaultRoot} (${origin})`);
  log.info(`Link    : ${opts.link || 'auto'}   Preserve: ${preserve ? 'on' : 'off'}   Force: ${opts.force ? 'on' : 'off'}`);
  if (dryRun) log.warn('Mode    : DRY RUN — nothing will be written');
  for (const w of warnings) log.warn(w);
  log.raw('');

  const plans = planProject({
    projectRoot, targetSelector: opts.target, vars, templatesDir: paths.templatesDir,
    vaultRoot, linkType: opts.link, preserve, force: Boolean(opts.force), platform, withDoc: command === 'init',
  });

  let exit = 0;
  for (const plan of plans) {
    log.step(`target: ${plan.target}`);
    for (const n of plan.notes) log.grey(n);
    if (plan.conflicts.length > 0) {
      for (const c of plan.conflicts) elog.err(`${c.path}: ${c.reason}`);
      exit = 3;
      continue;
    }
    if (plan.actions.length === 0) { log.ok('up to date'); continue; }
    if (dryRun) { for (const a of plan.actions) log.dry(`would ${describeAction(a)}`); continue; }
    const { applied, skipped } = applyPlan(plan);
    for (const a of plan.actions) log.ok(describeAction(a));
    for (const s of skipped) log.warn(`skipped ${s.destination}: ${s.reason}`);
    void applied;
  }
  return exit;
}

// ─── doctor ──────────────────────────────────────────────────────────────────

function cmdDoctor({ paths, env, cwd, opts, log, elog, stdout }) {
  const projectRoot = path.resolve(cwd, opts.path || '.');
  const config = loadConfig(paths);
  const { root: vaultRoot, origin, warnings } = resolveDeployRoot({ cliVault: opts.vault, env, paths, config });
  const report = inspectProject({ projectRoot, vaultRoot });
  report.vaultOrigin = origin;
  report.warnings = warnings;
  report.library = report.vault.ok ? inspectLibrary({ root: vaultRoot, homedir: paths.homedir, config }) : null;

  if (opts.json) { stdout.write(JSON.stringify(report, null, 2) + '\n'); return report.ok ? 0 : 1; }

  log.step('agentforge doctor');
  log.info(`Project : ${report.projectRoot}`);
  log.info(`Vault   : ${vaultRoot} (${origin})`);
  if (report.vault.physical.toLowerCase() !== path.resolve(vaultRoot).toLowerCase()) log.grey(`↳ resolves to ${report.vault.physical}`);
  for (const w of warnings) log.warn(w);
  log.raw('');
  if (report.vault.ok) {
    const extra = report.vault.viewLinks !== undefined ? `, ${report.vault.viewLinks} of them through links` : '';
    log.ok(`vault present (${report.vault.skills} skills with SKILL.md${extra}${report.vault.rejected ? `, ${report.vault.rejected} entries without` : ''})`);
  } else elog.err(`vault not usable: ${report.vault.state}`);

  if (report.library) printLibraryHealth(report.library, log);
  log.raw('');
  for (const t of report.targets) {
    const docMark = t.docExists ? '✓' : '·';
    const linkMark = t.link.kind === 'missing' ? '·' : t.linkHealth === 'broken' || t.linkHealth.startsWith('file') ? '✗' : '✓';
    log.info(`${t.id.padEnd(12)}  doc:${docMark}  link:${linkMark}  ${t.link.kind === 'missing' ? '' : t.linkHealth}`);
    if (t.link.kind === 'link') log.grey(`               ↳ ${t.link.broken ? 'BROKEN → ' : '→ '}${t.link.resolvedTarget || t.link.target}`);
  }
  return report.ok ? 0 : 1;
}

// ─── verify ──────────────────────────────────────────────────────────────────

/** Linked is a file check; this asks the tool. Writes nothing. Exit 0 only when the tool reported every sampled skill. */
function cmdVerify({ cwd, opts, log, elog, stdout }) {
  const projectRoot = path.resolve(cwd, opts.path || '.');
  const result = verifyTarget({ projectRoot, target: opts.target || 'claude', tool: opts.tool, trustWorkspace: Boolean(opts.trustWorkspace) });
  if (opts.json) { stdout.write(JSON.stringify(result, null, 2) + '\n'); return result.level === 'verified' ? 0 : 1; }
  log.step('agentforge verify');
  log.info(`Project : ${projectRoot}`);
  log.info(`Asking  : ${result.tool} about ${result.folder}`);
  if (result.sampled.length) log.grey(`sampled: ${result.sampled.join(', ')}`);
  log.raw('');
  if (result.level === 'verified') log.ok(`${result.detail} (${result.seconds}s)`);
  else elog.err(`${result.level}: ${result.detail}`);
  return result.level === 'verified' ? 0 : 1;
}

/** Whether the skills can actually be invoked: rule problems, listing budget, and personal skills that hide linked ones. */
function printLibraryHealth(lib, log) {
  const problems = lib.findings.filter((f) => f.severity !== 'info');
  if (problems.length === 0) log.ok(`skill rules: no problems in ${lib.skills} skills`);
  else {
    log.warn(`skill rules: ${lib.counts.error} will not load in some tools, ${lib.counts.warn} degraded`);
    for (const f of problems.slice(0, 8)) log.grey(`${f.severity === 'error' ? '✗' : '!'} ${f.message} [${f.tools.join(', ')}]`);
    if (problems.length > 8) log.grey(`… and ${problems.length - 8} more (use --json for all)`);
  }
  const b = lib.budget;
  const size = `${b.descriptionChars.toLocaleString('en-US')} description characters against a listing budget of about ${b.budgetChars.toLocaleString('en-US')}`;
  if (b.fits) log.ok(`listing: ${size}; every description fits`);
  else log.warn(`listing: ${size}; at least ${b.dropped} of ${b.entries} descriptions will not be shown to the agent (calling a skill by name still works)`);
  for (const s of lib.shadows) log.warn(`${s.name}: your ${s.level} ${s.tool} skill at ${s.path} takes precedence over the linked one`);
}

// ─── repo ────────────────────────────────────────────────────────────────────

function cmdRepo(positional, { paths, env, opts, log, elog, stdout, git }) {
  const [action, arg] = positional;
  switch (action) {
    case 'add': {
      const rec = addSource({ paths, urlOrPath: arg, name: opts.name, branch: opts.branch });
      log.ok(`registered ${rec.type} source "${rec.name}" (${rec.url_or_path}${rec.branch ? ' @ ' + rec.branch : ''})`);
      log.grey('run "agentforge repo sync" to fetch and rebuild the merged view');
      return 0;
    }
    case 'remove': {
      const { repo, removedCache } = removeSource({ paths, name: arg });
      log.ok(`unregistered "${repo.name}"${removedCache ? ' and deleted its cached clone' : ''}`);
      if (repo.type === 'local') log.grey(`local path left untouched: ${repo.url_or_path}`);
      log.grey('run "agentforge repo sync --no-fetch" to rebuild the merged view');
      return 0;
    }
    case 'list': {
      const rows = listSources({ paths, git });
      if (opts.json) { stdout.write(JSON.stringify(rows, null, 2) + '\n'); return 0; }
      log.step('agentforge repo list');
      if (rows.length === 0) { log.info('no sources registered'); log.grey('use "agentforge repo add <url-or-path>"'); return 0; }
      for (const r of rows) {
        log.info(`[${r.type}] ${r.name}  (${r.status}${r.revision ? ' @ ' + r.revision : ''})`);
        log.grey(`${r.url_or_path}${r.branch ? ' @ ' + r.branch : ''}  —  ${r.skills} skills${r.rejected ? `, ${r.rejected} rejected` : ''}`);
      }
      return 0;
    }
    case 'fetch': {
      log.step('agentforge repo fetch');
      const results = fetchSources({ paths, git, only: arg });
      return reportFetch(results, log, elog);
    }
    case 'sync': {
      log.step('agentforge repo sync');
      const dryRun = Boolean(opts.dryRun);
      const res = syncView({ paths, env, cliVault: opts.vault, forceExternal: Boolean(opts.force), fetch: !opts.noFetch, dryRun, git });
      log.info(`Vault  : ${res.primaryRoot}`);
      log.info(`View   : ${res.viewDir}`);
      if (opts.force) log.warn('Mode   : --force (external skills override vault skills on name collision)');
      if (dryRun) log.warn('Mode   : DRY RUN');
      log.raw('');
      let exit = res.fetch.length ? reportFetch(res.fetch, log, elog) : 0;
      for (const c of res.view.collisions) {
        const why = c.by === 'choice' ? (c.stale ? 'your choice; a copy has changed since, review it' : 'your choice') : c.by === 'order' ? 'source order' : 'default order';
        log.warn(`${c.name}: kept ${c.kept}, dropped ${c.dropped} (${why})`);
      }
      if (res.view.identical.length) log.grey(`${res.view.identical.length} identical ${res.view.identical.length === 1 ? 'copy' : 'copies'} collapsed: ${res.view.identical.slice(0, 6).map((c) => c.name).join(', ')}${res.view.identical.length > 6 ? '…' : ''}`);
      for (const r of res.view.rejected) log.grey(`rejected [${r.source}] ${r.path}: ${r.reason}`);
      const bySource = {};
      for (const e of res.view.entries) bySource[e.source] = (bySource[e.source] || 0) + 1;
      const summary = Object.entries(bySource).map(([s, n]) => `${n} from ${s}`).join(', ');
      if (dryRun) log.dry(`would link ${res.view.entries.length} skills (${summary})`);
      else log.ok(`merged view built: ${res.linked} skills linked (${summary})`);
      return exit;
    }
    default:
      elog.err(`usage: agentforge repo <add|remove|list|fetch|sync> ...`);
      return 2;
  }
}

function reportFetch(results, log, elog) {
  let failed = 0;
  for (const r of results) {
    if (r.status === 'failed') { failed++; elog.err(`${r.name}: ${r.error}`); }
    else if (r.status === 'skipped') log.grey(`${r.name}: skipped`);
    else log.ok(`${r.name}: ${r.status}${r.revision ? ' @ ' + r.revision : ''}`);
  }
  if (failed) elog.err(`${failed} source(s) failed to fetch`);
  return failed ? 1 : 0;
}

module.exports = { run, HELP };

if (require.main === module) {
  process.exitCode = run(process.argv.slice(2));
}
