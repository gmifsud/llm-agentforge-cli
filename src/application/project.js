'use strict';

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { TARGETS, resolveTargets } = require('../domain/targets');
const { newPlan, planDoc, planSkillsLink, planGitignore } = require('../deployment/plan');
const { inspectDestination, realOrResolved } = require('../infra/fs-inspect');
const { discoverSkills } = require('../discovery/discover-skills');

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

/** One plan per target. `withDoc` false = `link` command. */
function planProject({ projectRoot, targetSelector, vars, templatesDir, vaultRoot, linkType, preserve, force, platform, withDoc = true }) {
  const root = path.resolve(projectRoot);
  const plans = [];
  const seenDocs = new Set();
  for (const target of resolveTargets(targetSelector)) {
    const plan = newPlan(target, root);
    if (!fs.existsSync(root)) plan.actions.push({ kind: 'mkdir', destination: root });
    if (withDoc) {
      // codex and generic share AGENTS.md: plan it once.
      if (!seenDocs.has(target.doc)) { planDoc(plan, { projectRoot: root, target, templatesDir, vars, force }); seenDocs.add(target.doc); }
      else plan.notes.push(`${target.doc} planned for an earlier target`);
    }
    planSkillsLink(plan, { projectRoot: root, target, vaultRoot, linkType, preserve, force, platform });
    planGitignore(plan, { projectRoot: root, target });
    plans.push(plan);
  }
  return plans;
}

/** Structured diagnostics. Presence is reported separately from health. */
function inspectProject({ projectRoot, vaultRoot }) {
  const root = path.resolve(projectRoot);
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
    const d = discoverSkills(vaultRoot, { maxDepth: 1, manifest: false });
    vault.skills = d.skills.length;
    vault.rejected = d.rejected.filter((r) => r.reason !== 'symbolic link skipped during scan').length;
    // A merged view is a directory of links; count those too.
    if (vaultState.kind === 'directory') {
      const links = vaultState.entries.filter((e) => inspectDestination(path.join(vaultRoot, e)).kind === 'link');
      if (links.length > 0) {
        vault.skills = links.filter((e) => fs.existsSync(path.join(vaultRoot, e, 'SKILL.md'))).length;
        vault.viewLinks = links.length;
        vault.rejected = 0;
      }
    }
  }

  const targets = Object.values(TARGETS).map((t) => {
    const docPath = path.join(root, t.doc);
    const linkPath = path.join(root, t.dir, 'skills');
    const link = inspectDestination(linkPath);
    let linkHealth = 'absent';
    if (link.kind === 'link') linkHealth = link.broken ? 'broken' : 'link';
    else if (link.kind === 'directory') linkHealth = `directory (${link.entries.length} entries)`;
    else if (link.kind === 'file') linkHealth = 'file (conflict)';
    return { id: t.id, doc: t.doc, docExists: fs.existsSync(docPath), dir: t.dir, link, linkHealth };
  });

  return { projectRoot: root, vault, targets, ok: vault.ok && targets.every((t) => t.linkHealth !== 'broken' && !t.linkHealth.startsWith('file')) };
}

module.exports = { buildVars, planProject, inspectProject };
