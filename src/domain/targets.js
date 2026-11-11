'use strict';

/**
 * Single authoritative target matrix.
 * A target is the dot-folder + instruction-document contract one agent tool expects.
 *
 * What each tool actually loads was measured on 2026-11-11 (see docs/DASHBOARD.md):
 *   Claude Code  .claude/skills                      follows links
 *   Codex        .codex/skills, .agents/skills       follows links
 *   Gemini CLI   .gemini/skills, .agents/skills      follows links
 *   Cursor       .cursor, .agents, .claude, .codex   follows links
 *   Antigravity  .agents/skills only                 does NOT follow links: needs a copy
 *
 * optIn:    not part of "all"; ask for it by name.
 * copyOnly: the tool ignores links, so its skills folder must be a real copy.
 */
const TARGETS = Object.freeze({
  claude:      Object.freeze({ id: 'claude',      doc: 'CLAUDE.md', dir: '.claude', tmpl: 'CLAUDE.md.tmpl' }),
  codex:       Object.freeze({ id: 'codex',       doc: 'AGENTS.md', dir: '.codex',  tmpl: 'AGENTS.md.tmpl' }),
  generic:     Object.freeze({ id: 'generic',     doc: 'AGENTS.md', dir: '.agents', tmpl: 'AGENTS.md.tmpl' }),
  gemini:      Object.freeze({ id: 'gemini',      doc: 'GEMINI.md', dir: '.gemini', tmpl: 'GEMINI.md.tmpl' }),
  cursor:      Object.freeze({ id: 'cursor',      doc: 'AGENTS.md', dir: '.cursor', tmpl: 'AGENTS.md.tmpl', optIn: true }),
  antigravity: Object.freeze({ id: 'antigravity', doc: 'AGENTS.md', dir: '.agents', tmpl: 'AGENTS.md.tmpl', optIn: true, copyOnly: true }),
});

const TARGET_IDS = Object.freeze(Object.keys(TARGETS));
const DEFAULT_TARGET = 'claude';

/** Accepts one id, "all" (every target that is not opt-in), or a list of ids. */
function resolveTargets(selector) {
  const { usage } = require('./errors');
  const list = Array.isArray(selector) ? selector : [selector || DEFAULT_TARGET];
  const out = [];
  for (const sel of list) {
    if (sel === 'all') { out.push(...TARGET_IDS.filter((id) => !TARGETS[id].optIn).map((id) => TARGETS[id])); continue; }
    const t = TARGETS[sel];
    if (!t) throw usage(`invalid target "${sel}" (expected ${TARGET_IDS.join(' | ')} | all)`);
    out.push(t);
  }
  return [...new Set(out)];
}

module.exports = { TARGETS, TARGET_IDS, DEFAULT_TARGET, resolveTargets };
