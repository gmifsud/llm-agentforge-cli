'use strict';

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { TARGETS, resolveTargets } = require('../domain/targets');
const { newPlan, planDoc, planSkillsLink, planGitignore } = require('../deployment/plan');
const { inspectDestination, realOrResolved } = require('../infra/fs-inspect');
const { discoverSkills } = require('../discovery/discover-skills');
const { copyState } = require('../deployment/copy-state');

function buildVars({ projectRoot, name, stack, owner, build, test, run, env = {}, today = new Date() }) {
  return {
    PROJECT_NAME: name || path.basename(projectRoot),
    TECH_STACK: stack || '<fill in>',
    OWNER: owner || env.USERNAME || env.USER || safeUser(),
    REPO_ROOT: projectRoot,
    BOOTSTRAP_DATE: today.toISOString().slice(0, 10),
    BUILD_CMD: build || '<build>',
    TEST_CMD: test || '<test>',
    RUN_CMD: run || '<run>',
  };
}

function safeUser() { try { return os.userInfo().username; } catch { return 'unknown'; } }

/**
 * One plan per target. `withDoc` false = `link` command.
 * Targets that share a folder (generic and antigravity both use .agents) get one
 * skills folder between them; it is a copy if any of them cannot follow links.
 */
function planProject({ projectRoot, targetSelector, vars, templatesDir, vaultRoot, linkType, preserve, force, platform, withDoc = true }) {
  const root = path.resolve(projectRoot);
  const plans = [];
  const seenDocs = new Set();
  const targets = resolveTargets(targetSelector);
  const needsCopy = new Set(targets.filter((t) => t.copyOnly).map((t) => t.dir));
  const plannedDirs = new Map();
  for (const target of targets) {
    const plan = newPlan(target, root);
    if (!fs.existsSync(root)) plan.actions.push({ kind: 'mkdir', destination: root });
    if (withDoc) {
      // codex and generic share AGENTS.md: plan it once.
      if (!seenDocs.has(target.doc)) { planDoc(plan, { projectRoot: root, target, templatesDir, vars, force }); seenDocs.add(target.doc); }
      else plan.notes.push(`${target.doc} planned for an earlier target`);
    }
    if (plannedDirs.has(target.dir)) {
      plan.notes.push(`${target.dir}/skills is shared with ${plannedDirs.get(target.dir)} and planned there`);
    } else {
      plannedDirs.set(target.dir, target.id);
      planSkillsLink(plan, { projectRoot: root, target, vaultRoot, linkType, preserve, force, platform, copy: needsCopy.has(target.dir) });
      planGitignore(plan, { projectRoot: root, target });
    }
    plans.push(plan);
  }
  return plans;
}

/**
 * What the library holds. It depends only on the library, never on a project, so one read of many
 * projects can pass a `scan` map and pay for it once. A scan is valid for that read only.
 */
function inspectLibrary(vaultRoot, checkRead, scan) {
  if (scan && scan.has(vaultRoot)) return { ...scan.get(vaultRoot) };
  checkRead(vaultRoot);
  const vaultState = inspectDestination(vaultRoot);
  const vault = {
    path: vaultRoot,
    physical: realOrResolved(vaultRoot),
    state: vaultState.kind,
    ok: vaultState.kind === 'directory' || (vaultState.kind === 'link' && !vaultState.broken),
    skills: 0,
    rejected: 0,
  };
  if (vault.ok) {
    const d = discoverSkills(vaultRoot, { maxDepth: 1, manifest: false, checkRead });
    vault.skills = d.skills.length;
    vault.rejected = d.rejected.filter((r) => r.reason !== 'symbolic link skipped during scan').length;
    // Entries that are links also count: a merged view is all links, and a vault may hold a few.
    // They are added to the ordinary skill folders, never substituted for them.
    if (vaultState.kind === 'directory') {
      const links = vaultState.entries.filter((e) => { checkRead(path.join(vaultRoot, e)); return inspectDestination(path.join(vaultRoot, e)).kind === 'link'; });
      if (links.length > 0) {
        const linked = links.filter((e) => { checkRead(path.join(vaultRoot, e, 'SKILL.md')); return fs.existsSync(path.join(vaultRoot, e, 'SKILL.md')); }).length;
        vault.skills += linked;
        vault.viewLinks = links.length;
      }
    }
  }
  if (scan) scan.set(vaultRoot, vault);
  return { ...vault };
}

/** Structured diagnostics. Presence is reported separately from health. */
function inspectProject({ projectRoot, vaultRoot, checkRead = () => {}, scan }) {
  const root = path.resolve(projectRoot);
  checkRead(root);
  const vault = inspectLibrary(vaultRoot, checkRead, scan);

  const targets = Object.values(TARGETS).map((t) => {
    const docPath = path.join(root, t.doc);
    const linkPath = path.join(root, t.dir, 'skills');
    checkRead(docPath);
    checkRead(linkPath);
    const link = inspectDestination(linkPath);
    let linkHealth = 'absent';
    if (link.kind === 'link') linkHealth = link.broken ? 'broken' : 'link';
    else if (link.kind === 'directory') linkHealth = `directory (${link.entries.length} entries)`;
    // A tool that ignores links is not served by one, however healthy the link is.
    const needsCopy = Boolean(t.copyOnly) && link.kind === 'link';
    if (needsCopy) linkHealth = 'link (this tool does not follow links; it needs a copy)';
    let copy = null;
    if (link.kind === 'directory' && vault.ok) { try { copy = copyState(path.join(root, t.dir), vaultRoot); } catch { copy = null; } }
    if (copy && copy.managed) linkHealth = copy.state === 'fresh' ? `copy, up to date (${copy.names.length} skills)` : 'copy, out of date: the library changed since it was copied';
    else if (link.kind === 'file') linkHealth = 'file (conflict)';
    return { id: t.id, doc: t.doc, docExists: fs.existsSync(docPath), dir: t.dir, link, linkHealth, needsCopy, copy, optIn: Boolean(t.optIn) };
  });

  return { projectRoot: root, vault, targets, ok: vault.ok && targets.every((t) => t.linkHealth !== 'broken' && !t.linkHealth.startsWith('file')) };
}

module.exports = { buildVars, planProject, inspectProject };
