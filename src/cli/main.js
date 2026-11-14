#!/usr/bin/env node
'use strict';

const path = require('node:path');
const os = require('node:os');
const { parseArgs } = require('./args');
const { AgentforgeError, usage, refused } = require('../domain/errors');
const { createPaths, loadConfig, resolveDeployRoot } = require('../infra/paths');
const { createGit } = require('../infra/git');
const { buildVars, planProject, inspectProject } = require('../application/project');
const { inspectLibrary } = require('../application/health');
const { verifyTarget } = require('../application/verify');
const { applyPlan, describeAction } = require('../deployment/apply');
const { addSource, removeSource, listSources, fetchSources } = require('../application/sources');
const { syncView, computeLibrary } = require('../application/sync');
const sets = require('../application/sets');
const { parseRule, resolveSet } = require('../domain/sets');
const { planChecks, runChecks } = require('../application/check');
const { loadSavedProjects } = require('../infra/projects');

const HELP = `agentforge — bootstrap a repo with a token-optimised CLAUDE.md / AGENTS.md / GEMINI.md
and a junction/symlink to the shared skill vault. Idempotent. Non-destructive unless --force.

Usage:
  agentforge init   [--path P] [--target claude|codex|generic|gemini|cursor|antigravity|all] [--name N] [--stack S]
                    [--owner O] [--build C] [--test C] [--run C] [--vault V]
                    [--link junction|symlink|copy|none|auto] [--dry-run] [--force] [--no-preserve]
  agentforge link   [--path P] [--target T] [--vault V | --set NAME] [--link L] [--dry-run] [--force] [--no-preserve]
                                             --set points the agent at a set instead of the whole library
  agentforge doctor [--path P] [--vault V] [--json]
  agentforge verify [--path P] [--target T] [--tool claude|codex|gemini|cursor|antigravity] [--json]
                                             ask the agent tool itself whether it sees the wired skills
  agentforge update [--vault V] [--force] [--no-fetch] [--dry-run]
                                             fetch every Git source, then rebuild the library (same as repo sync)
  agentforge check  [--path P] [--dry-run] [--json]
                                             ask every working agent in every remembered project whether it sees
                                             the skills; one that cannot be asked does not stop the rest
  agentforge set create <name> --include type:value [--include ...] [--exclude type:value ...] [--force]
                                             a set is a shortlist of the library, so an agent sees all of its skill
                                             descriptions. type is skill, name (orcaflex-*), source or category.
                                             Excludes apply after includes. The set is built at once.
  agentforge set list [--json]               every set and how many skills it holds
  agentforge set show <name> [--json]        its rules, its skills, and how much of its listing an agent will see
  agentforge set build [name]                rebuild sets from the library (update does this too)
  agentforge set remove <name> [--force]     refused while an agent reads it, unless forced
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
  verifyRun,
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
      case 'update':
        return cmdSync('agentforge update', { paths, env, opts, log, elog, git: gitClient });
      case 'check':
        return cmdCheck({ paths, cwd, opts, log, elog, stdout, verifyRun });
      case 'set':
        return cmdSet(positional, { paths, env, opts, log, elog, stdout });
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
  const { root: vaultRoot, origin, warnings } = opts.set
    ? { root: sets.viewForLink(paths, opts.set), origin: `set ${opts.set}`, warnings: [] }
    : resolveDeployRoot({ cliVault: opts.vault, env, paths, config });
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
  for (const t of report.targets) t.reads = t.link.kind === 'link' ? sets.readsOf(paths, t.link.resolvedTarget) : { kind: 'other' };
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
    if (t.reads.kind === 'set') log.grey(`               ↳ reads set ${t.reads.name}`);
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
    case 'sync':
      return cmdSync('agentforge repo sync', { paths, env, opts, log, elog, git });
    default:
      elog.err(`usage: agentforge repo <add|remove|list|fetch|sync> ...`);
      return 2;
  }
}

/** Fetch every Git source (one that fails does not stop the others), then rebuild the library. `update` and `repo sync` are this. */
function cmdSync(title, { paths, env, opts, log, elog, git }) {
  log.step(title);
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
  printSinceLastBuild(res.lock, log);
  printSets(res.sets, dryRun, log);
  return exit;
}

/** The sets built with the library, or on a dry run the ones that would be. A rule that selects nothing is warned about. */
function printSets(rows, dryRun, log) {
  if (!rows.length) return;
  const skills = (n) => `${n} ${n === 1 ? 'skill' : 'skills'}`;
  for (const s of rows) for (const r of s.unmatched) log.warn(`set "${s.name}": ${r.type}:${r.value} selects no skill`);
  if (dryRun) log.dry(`would build ${rows.length} ${rows.length === 1 ? 'set' : 'sets'}: ${rows.map((s) => `${s.name} (${skills(s.count)})`).join(', ')}`);
  else log.ok(`sets built: ${rows.map((s) => `${s.name} (${skills(s.linked)})`).join(', ')}`);
}

/** What changed in the sources since the last build, from the lock record. A dry run shows it without recording it. */
function printSinceLastBuild(lock, log) {
  const c = lock.changes;
  if (c.first) { log.grey('no earlier build on record, so there is nothing to compare with'); return; }
  const names = (list) => `${list.slice(0, 8).join(', ')}${list.length > 8 ? ` and ${list.length - 8} more` : ''}`;
  const rows = [['added', c.added], ['removed', c.removed], ['content changed', c.changed], ['moved to another source', c.moved]].filter(([, list]) => list.length);
  if (!rows.length) { log.grey('no skill changed since the last build'); return; }
  log.info('since the last build:');
  for (const [what, list] of rows) log.grey(`${what}: ${list.length}  (${names(list)})`);
}

// ─── set ─────────────────────────────────────────────────────────────────────

const fitsText = (b) => (b.fits ? 'every description fits' : `about ${b.kept} of ${b.entries} descriptions fit`);

/** A set is a shortlist of the library, by rule, built as its own folder of links. */
function cmdSet(positional, { paths, env, opts, log, elog, stdout }) {
  const [action, name] = positional;
  const library = () => computeLibrary({ paths, env, cliVault: opts.vault });
  const budgetOf = (config, entries) => sets.setBudget(entries, { budgetChars: config.listingBudgetChars, contextTokens: config.contextTokens });
  const skills = (n) => `${n} ${n === 1 ? 'skill' : 'skills'}`;
  switch (action) {
    case 'list': {
      const lib = sets.describeEntries(library().view.entries);
      const doc = sets.loadSets(paths);
      const rows = Object.keys(doc.sets).map((n) => ({ name: n, rules: doc.sets[n].rules.length, skills: resolveSet(doc.sets[n], lib).entries.length }));
      if (opts.json) { stdout.write(JSON.stringify(rows, null, 2) + '\n'); return 0; }
      log.step('agentforge set list');
      if (!rows.length) { log.info('no sets yet'); log.grey('use "agentforge set create <name> --include category:..."'); return 0; }
      for (const r of rows) log.info(`${r.name}  ${skills(r.skills)}  (${r.rules} ${r.rules === 1 ? 'rule' : 'rules'})`);
      return 0;
    }
    case 'show': {
      if (!name) throw usage('usage: agentforge set show <name>');
      const { config, view } = library();
      const doc = sets.loadSets(paths);
      if (!doc.sets[name]) throw refused('NO_SUCH_SET', `no set called "${name}"`);
      const resolved = resolveSet(doc.sets[name], sets.describeEntries(view.entries));
      const budget = budgetOf(config, resolved.entries);
      if (opts.json) { stdout.write(JSON.stringify({ name, skills: resolved.entries.map((e) => e.name), rules: resolved.rules, unmatched: resolved.unmatched, budget }, null, 2) + '\n'); return 0; }
      log.step(`agentforge set show ${name}`);
      for (const r of resolved.rules) log.info(`${r.exclude ? '−' : '+'} ${r.type}:${r.value}  (${r.exclude ? `removes ${r.removed}` : `${skills(r.matched)}, ${r.added} new`})`);
      for (const r of resolved.unmatched) log.warn(`${r.type}:${r.value} selects no skill`);
      log.raw('');
      log.ok(`${skills(resolved.entries.length)}; ${fitsText(budget)}`);
      log.grey(resolved.entries.map((e) => e.name).join(', '));
      return 0;
    }
    case 'create': {
      if (!name) throw usage('usage: agentforge set create <name> --include type:value [--include ...] [--exclude type:value ...]');
      const rules = [...(opts.include || []).map((t) => parseRule(t)), ...(opts.exclude || []).map((t) => parseRule(t, { exclude: true }))];
      const { config, view } = library();
      const made = sets.createSet({ paths, name, rules, entries: view.entries, force: Boolean(opts.force) });
      log.ok(`set "${name}": ${skills(made.linked)}, ${fitsText(budgetOf(config, made.resolved.entries))}`);
      log.grey(`built at ${sets.setView(paths, name)}`);
      log.grey(`point an agent at it with: agentforge link --set ${name} --target <agent>`);
      return 0;
    }
    case 'build': {
      const { view } = library();
      const rows = sets.buildSets({ paths, entries: view.entries, only: name, dryRun: Boolean(opts.dryRun) });
      if (name && !rows.length) throw refused('NO_SUCH_SET', `no set called "${name}"`);
      log.step('agentforge set build');
      if (!rows.length) { log.info('no sets to build'); return 0; }
      printSets(rows, Boolean(opts.dryRun), log);
      return 0;
    }
    case 'remove': {
      if (!name) throw usage('usage: agentforge set remove <name> [--force]');
      const r = sets.removeSet({ paths, name, force: Boolean(opts.force) });
      log.ok(`removed set "${name}"${r.removedView ? ' and its folder of links' : ''}`);
      if (r.readers.length) log.warn(`${r.readers.length} agent ${r.readers.length === 1 ? 'link now points' : 'links now point'} at a folder that is gone`);
      log.grey('the skills themselves are untouched');
      return 0;
    }
    default:
      elog.err('usage: agentforge set <create|list|show|build|remove> ...');
      return 2;
  }
}

// ─── check ───────────────────────────────────────────────────────────────────

/**
 * Ask every working agent in every remembered project (or just --path) whether its tool sees the skills.
 * Each check runs on its own, so one that cannot be made does not stop the rest. Writes nothing.
 */
function cmdCheck({ paths, cwd, opts, log, elog, stdout, verifyRun }) {
  const projects = opts.path ? [path.resolve(cwd, opts.path)] : loadSavedProjects(paths);
  const items = projects.length ? planChecks({ projects, libraryRoot: paths.mergedSkills }) : [];
  const where = (p) => path.relative(cwd, p) || p;
  if (opts.dryRun) {
    if (opts.json) { stdout.write(JSON.stringify(items.map((i) => ({ project: i.projectRoot, target: i.target })), null, 2) + '\n'); return 0; }
    log.step('agentforge check');
    if (!projects.length) { log.info('no projects to check'); log.grey('add projects in the dashboard, or use --path <folder>'); return 0; }
    log.dry(`would ask ${items.length} ${items.length === 1 ? 'agent' : 'agents'}`);
    for (const i of items) log.grey(`${where(i.projectRoot)}  ${i.target}`);
    return 0;
  }
  if (!opts.json) {
    log.step('agentforge check');
    if (!projects.length) { log.info('no projects to check'); log.grey('add projects in the dashboard, or use --path <folder>'); return 0; }
    log.info(`Asking ${items.length} ${items.length === 1 ? 'agent' : 'agents'} in ${projects.length} ${projects.length === 1 ? 'project' : 'projects'}; most send one short question on your account`);
    log.raw('');
  }
  const results = runChecks(items, {
    run: verifyRun,
    onResult: (r) => { if (!opts.json) (r.level === 'verified' ? log.ok : elog.err)(`${where(r.project)}  ${r.target}: ${r.level === 'verified' ? r.detail : `${r.level}: ${r.detail}`}`); },
  });
  const failed = results.filter((r) => r.level !== 'verified').length;
  if (opts.json) { stdout.write(JSON.stringify(results, null, 2) + '\n'); return failed ? 1 : 0; }
  log.raw('');
  if (failed) elog.err(`${failed} of ${results.length} agents did not confirm they see the skills`);
  else if (results.length) log.ok(`all ${results.length} agents confirmed`);
  else log.info('no agent reads the library yet, so there is nothing to ask');
  return failed ? 1 : 0;
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
