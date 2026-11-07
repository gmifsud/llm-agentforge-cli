'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { inspectDestination, samePath, IS_WIN } = require('../infra/fs-inspect');
const { renderTemplateFile } = require('../render-template');

/**
 * Planning is read-only. A plan is data: { target, actions[], conflicts[], notes[] }.
 *
 * Action kinds (the executor supports exactly these):
 *   write-file        { destination, content }
 *   mkdir             { destination }
 *   create-link       { destination, source, linkType: 'junction' | 'symlink' }
 *   copy-directory    { destination, source }
 *   copy-entries      { destination, source, entries: string[] }   // merge missing entries only
 *   remove-link       { destination, expectedTarget }               // link only, never recursive
 *   remove-directory  { destination }                               // ordinary directory only
 *   append-gitignore  { destination, lines: string[] }
 */
function newPlan(target, projectRoot) {
  return { target: target.id, projectRoot, actions: [], conflicts: [], notes: [] };
}

function resolveLinkType(requested, platform = process.platform) {
  const lt = requested || 'auto';
  if (lt === 'auto') return platform === 'win32' ? 'junction' : 'symlink';
  if (lt === 'junction' && platform !== 'win32') return 'symlink';
  return lt;
}

// ─── instruction document ────────────────────────────────────────────────────

function planDoc(plan, { projectRoot, target, templatesDir, vars, force }) {
  const outPath = path.join(projectRoot, target.doc);
  if (fs.existsSync(outPath) && !force) {
    plan.notes.push(`${target.doc} already exists — skipping (use --force to overwrite)`);
    return plan;
  }
  const content = renderTemplateFile(path.join(templatesDir, target.tmpl), vars);
  plan.actions.push({ kind: 'write-file', destination: outPath, content });
  return plan;
}

// ─── skills link ─────────────────────────────────────────────────────────────

/**
 * Destination-state matrix (from the design note):
 *   missing                  → create
 *   link → expected source   → no-op
 *   link → other source      → conflict; --force repoints (remove-link + create)
 *   broken link              → conflict; --force repairs
 *   ordinary directory       → preserve: copy missing entries; --force --no-preserve: replace
 *   file                     → conflict
 * `none` returns before any inspection so it can never mutate.
 */
function planSkillsLink(plan, { projectRoot, target, vaultRoot, linkType, preserve = true, force = false, platform = process.platform }) {
  const effectiveType = resolveLinkType(linkType, platform);
  const dotDir = path.join(projectRoot, target.dir);
  const linkPath = path.join(dotDir, 'skills');

  if (effectiveType === 'none') {
    plan.notes.push(`${target.dir}/skills: link type "none" — nothing to do`);
    return plan;
  }

  const vaultState = inspectDestination(vaultRoot);
  if (vaultState.kind === 'missing' || vaultState.kind === 'file' || (vaultState.kind === 'link' && vaultState.broken)) {
    plan.conflicts.push({ path: vaultRoot, reason: 'vault root does not exist or is not a directory' });
    return plan;
  }

  if (inspectDestination(dotDir).kind === 'missing') plan.actions.push({ kind: 'mkdir', destination: dotDir });

  const createAction = () =>
    effectiveType === 'copy'
      ? { kind: 'copy-directory', destination: linkPath, source: vaultRoot }
      : { kind: 'create-link', destination: linkPath, source: vaultRoot, linkType: effectiveType };

  const dest = inspectDestination(linkPath);

  switch (dest.kind) {
    case 'missing':
      plan.actions.push(createAction());
      return plan;

    case 'link': {
      if (!dest.broken && samePath(dest.resolvedTarget, vaultRoot)) {
        plan.notes.push(`${target.dir}/skills already links to ${vaultRoot}`);
        return plan;
      }
      const what = dest.broken ? `broken link (→ ${dest.target})` : `link to another source (→ ${dest.resolvedTarget || dest.target})`;
      if (!force) {
        plan.conflicts.push({ path: linkPath, reason: `${what}; rerun with --force to repoint it. Nothing is merged into a linked folder.` });
        return plan;
      }
      plan.actions.push({ kind: 'remove-link', destination: linkPath, expectedTarget: dest.target });
      plan.actions.push(createAction());
      return plan;
    }

    case 'directory': {
      if (preserve) {
        const existing = new Set(dest.entries.map((e) => (IS_WIN ? e.toLowerCase() : e)));
        const incoming = fs.readdirSync(vaultRoot).filter((e) => !existing.has(IS_WIN ? e.toLowerCase() : e));
        const kept = dest.entries.length;
        if (incoming.length === 0) plan.notes.push(`${target.dir}/skills: preserved ${kept} existing entries; nothing to merge`);
        else plan.actions.push({ kind: 'copy-entries', destination: linkPath, source: vaultRoot, entries: incoming, kept });
        return plan;
      }
      if (!force) {
        plan.conflicts.push({ path: linkPath, reason: 'directory exists; use --force --no-preserve to replace it' });
        return plan;
      }
      plan.actions.push({ kind: 'remove-directory', destination: linkPath });
      plan.actions.push(createAction());
      return plan;
    }

    default:
      plan.conflicts.push({ path: linkPath, reason: 'a file is in the way' });
      return plan;
  }
}

// ─── .gitignore ──────────────────────────────────────────────────────────────

/** Ignore only the generated deployment artefact, never the instruction doc or the whole dot-folder. */
function planGitignore(plan, { projectRoot, target }) {
  const ignoreFile = path.join(projectRoot, '.gitignore');
  const wanted = `${target.dir}/skills`;
  let existing = [];
  if (fs.existsSync(ignoreFile)) existing = fs.readFileSync(ignoreFile, 'utf8').split(/\r?\n/).map((l) => l.trim());
  if (existing.includes(wanted) || existing.includes(`${wanted}/`) || existing.includes(`${target.dir}/`)) return plan;
  plan.actions.push({ kind: 'append-gitignore', destination: ignoreFile, lines: [wanted] });
  return plan;
}

module.exports = { newPlan, planDoc, planSkillsLink, planGitignore, resolveLinkType };
