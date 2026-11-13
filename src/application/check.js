'use strict';
/**
 * Asking every agent at once: which agents reach the library right now, and asking each of their tools whether it
 * sees the skills. The question for one agent is verify.js; this is the loop around it.
 */
const { inspectProject } = require('./project');
const { verifyTarget } = require('./verify');
const { samePath } = require('../infra/fs-inspect');

/** The agents in a project that reach the library now: through a link to it, or through a copy that is up to date. */
function workingAgents({ projectRoot, libraryRoot }) {
  const report = inspectProject({ projectRoot, vaultRoot: libraryRoot });
  return report.targets.filter((t) => {
    const viaLink = t.link.kind === 'link' && !t.link.broken && !t.needsCopy && t.link.resolvedTarget && samePath(t.link.resolvedTarget, libraryRoot);
    const viaCopy = t.link.kind === 'directory' && t.copy && t.copy.managed && t.copy.state === 'fresh';
    return Boolean(viaLink || viaCopy);
  }).map((t) => t.id);
}

/** Every working agent in these projects, as { projectRoot, target }. A folder that cannot be read has none. */
function planChecks({ projects, libraryRoot }) {
  return projects.flatMap((projectRoot) => {
    try { return workingAgents({ projectRoot, libraryRoot }).map((target) => ({ projectRoot, target })); } catch { return []; }
  });
}

/** Ask each agent in turn. One that cannot be asked is recorded as such and the others still go ahead. */
function runChecks(items, { run, onResult = () => {} } = {}) {
  return items.map(({ projectRoot, target }) => {
    let r;
    try { r = verifyTarget({ projectRoot, target, ...(run ? { run } : {}) }); } catch (e) {
      r = { tool: '', level: 'unavailable', seconds: 0, detail: e && e.message ? e.message : String(e) };
    }
    const out = { project: projectRoot, target, tool: r.tool, level: r.level, detail: r.detail, seconds: r.seconds };
    onResult(out);
    return out;
  });
}

module.exports = { workingAgents, planChecks, runChecks };
