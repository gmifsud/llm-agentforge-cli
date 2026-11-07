'use strict';

/**
 * Single authoritative target matrix.
 * A target is the dot-folder + instruction-document contract one harness expects.
 */
const TARGETS = Object.freeze({
  claude:  Object.freeze({ id: 'claude',  doc: 'CLAUDE.md', dir: '.claude', tmpl: 'CLAUDE.md.tmpl' }),
  codex:   Object.freeze({ id: 'codex',   doc: 'AGENTS.md', dir: '.codex',  tmpl: 'AGENTS.md.tmpl' }),
  generic: Object.freeze({ id: 'generic', doc: 'AGENTS.md', dir: '.agents', tmpl: 'AGENTS.md.tmpl' }),
  gemini:  Object.freeze({ id: 'gemini',  doc: 'GEMINI.md', dir: '.gemini', tmpl: 'GEMINI.md.tmpl' }),
});

const TARGET_IDS = Object.freeze(Object.keys(TARGETS));
const DEFAULT_TARGET = 'claude';

function resolveTargets(selector) {
  const sel = selector || DEFAULT_TARGET;
  if (sel === 'all') return TARGET_IDS.map((id) => TARGETS[id]);
  const t = TARGETS[sel];
  if (!t) {
    const { usage } = require('./errors');
    throw usage(`invalid target "${sel}" (expected ${TARGET_IDS.join(' | ')} | all)`);
  }
  return [t];
}

module.exports = { TARGETS, TARGET_IDS, DEFAULT_TARGET, resolveTargets };
