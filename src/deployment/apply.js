'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { inspectDestination, removeLinkOnly, createDirectoryLink } = require('../infra/fs-inspect');
const { refused } = require('../domain/errors');

/**
 * The only module that mutates a project. Every action re-validates its
 * precondition right before acting, so a plan that went stale is refused
 * rather than applied blindly.
 *
 * Returns { applied: [{ kind, destination }], skipped: [...] }.
 * With dryRun: true nothing is touched and every action is reported as "would".
 */
function applyPlan(plan, { dryRun = false } = {}) {
  const applied = [];
  const skipped = [];

  if (plan.conflicts.length > 0) {
    throw refused('PLAN_CONFLICTS', `plan for ${plan.target} has ${plan.conflicts.length} conflict(s); nothing applied`, plan.conflicts);
  }

  for (const a of plan.actions) {
    if (dryRun) { applied.push({ ...a, dry: true }); continue; }
    switch (a.kind) {
      case 'write-file':
        fs.mkdirSync(path.dirname(a.destination), { recursive: true });
        fs.writeFileSync(a.destination, a.content, 'utf8');
        break;

      case 'mkdir':
        fs.mkdirSync(a.destination, { recursive: true });
        break;

      case 'create-link': {
        const st = inspectDestination(a.destination);
        if (st.kind !== 'missing') throw refused('STALE_PLAN', `${a.destination} appeared since planning (${st.kind})`);
        createDirectoryLink(a.source, a.destination, a.linkType);
        break;
      }

      case 'copy-directory': {
        if (inspectDestination(a.destination).kind !== 'missing') throw refused('STALE_PLAN', `${a.destination} appeared since planning`);
        fs.cpSync(a.source, a.destination, { recursive: true, dereference: true });
        if (a.marker) writeMarker(a.marker);
        break;
      }

      case 'refresh-copy': {
        const st = inspectDestination(a.destination);
        if (st.kind !== 'directory') throw refused('STALE_PLAN', `${a.destination} is no longer an ordinary directory (${st.kind}); refusing to refresh`);
        // Remove only what a previous copy put there; anything else in the folder is the user's.
        for (const name of a.managed) {
          if (/[\\/]/.test(name) || name === '..' || name === '.') continue;
          const p = path.join(a.destination, name);
          const es = inspectDestination(p);
          if (es.kind === 'directory') fs.rmSync(p, { recursive: true, force: true });
          else if (es.kind === 'link') removeLinkOnly(p);
        }
        for (const name of a.entries) {
          const dest = path.join(a.destination, name);
          if (inspectDestination(dest).kind !== 'missing') { skipped.push({ kind: a.kind, destination: dest, reason: 'yours, not replaced' }); continue; }
          fs.cpSync(path.join(a.source, name), dest, { recursive: true, dereference: true });
        }
        writeMarker(a.marker);
        break;
      }

      case 'copy-entries': {
        const st = inspectDestination(a.destination);
        if (st.kind !== 'directory') throw refused('STALE_PLAN', `${a.destination} is no longer an ordinary directory (${st.kind}); refusing to merge`);
        for (const name of a.entries) {
          const dest = path.join(a.destination, name);
          if (inspectDestination(dest).kind !== 'missing') { skipped.push({ kind: a.kind, destination: dest, reason: 'appeared since planning' }); continue; }
          fs.cpSync(path.join(a.source, name), dest, { recursive: true, dereference: true });
        }
        break;
      }

      case 'remove-link': {
        const st = inspectDestination(a.destination);
        if (st.kind !== 'link') throw refused('STALE_PLAN', `${a.destination} is not a link any more (${st.kind})`);
        if (a.expectedTarget !== undefined && st.target !== a.expectedTarget) {
          throw refused('STALE_PLAN', `${a.destination} now points at ${st.target}, expected ${a.expectedTarget}`);
        }
        removeLinkOnly(a.destination);
        break;
      }

      case 'remove-directory': {
        const st = inspectDestination(a.destination);
        if (st.kind !== 'directory') throw refused('STALE_PLAN', `${a.destination} is not an ordinary directory (${st.kind}); refusing recursive removal`);
        fs.rmSync(a.destination, { recursive: true, force: true });
        break;
      }

      case 'append-gitignore': {
        let prefix = '';
        if (fs.existsSync(a.destination)) {
          const raw = fs.readFileSync(a.destination, 'utf8');
          if (raw.length > 0 && !/\r?\n$/.test(raw)) prefix = '\n';
          if (!raw.includes('# agentforge generated')) prefix += '# agentforge generated\n';
        } else {
          prefix = '# agentforge generated\n';
        }
        fs.appendFileSync(a.destination, prefix + a.lines.join('\n') + '\n', 'utf8');
        break;
      }

      default:
        throw refused('UNKNOWN_ACTION', `unknown action kind "${a.kind}"`);
    }
    applied.push({ kind: a.kind, destination: a.destination });
  }

  return { applied, skipped };
}

function writeMarker(marker) {
  fs.writeFileSync(marker.file, JSON.stringify({ ...marker.data, copiedAt: new Date().toISOString() }, null, 2) + '\n', 'utf8');
}

/** Human-readable one-liner per action, for previews and dry runs. */
function describeAction(a) {
  switch (a.kind) {
    case 'write-file': return `write ${a.destination} (${(a.content.length / 1024).toFixed(1)} KB)`;
    case 'mkdir': return `mkdir ${a.destination}`;
    case 'create-link': return `${a.linkType}: ${a.destination} -> ${a.source}`;
    case 'copy-directory': return `copy ${a.source} -> ${a.destination}`;
    case 'refresh-copy': return `refresh the copy in ${a.destination} from ${a.source} (${a.entries.length} skills; yours are kept)`;
    case 'copy-entries': return `merge ${a.entries.length} missing entr${a.entries.length === 1 ? 'y' : 'ies'} into ${a.destination} (keeping ${a.kept})`;
    case 'remove-link': return `remove link ${a.destination} (-> ${a.expectedTarget})`;
    case 'remove-directory': return `remove directory ${a.destination}`;
    case 'append-gitignore': return `append to ${a.destination}: ${a.lines.join(', ')}`;
    default: return JSON.stringify(a);
  }
}

module.exports = { applyPlan, describeAction };
