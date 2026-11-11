'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { lintSkill, findShadows, personalLevels } = require('../discovery/skill-lint');
const { estimateListing } = require('../discovery/listing-budget');

/**
 * Can the skills in this folder actually be invoked?
 * `root` is whatever a project links to: a vault, or a view (a folder of links).
 * Each immediate entry holding a SKILL.md is one skill; links are followed here
 * because that is exactly what the agent tool will do.
 *
 * Returns { skills, findings, counts, budget, shadows }.
 */
function inspectLibrary({ root, homedir, config = {} }) {
  let entries = [];
  try { entries = fs.readdirSync(root); } catch { /* reported by the caller as an unusable vault */ }
  const linted = [];
  for (const entry of entries.sort()) {
    const dir = path.join(root, entry);
    if (!fs.existsSync(path.join(dir, 'SKILL.md'))) continue;
    linted.push(lintSkill(dir));
  }
  const findings = linted.flatMap((s) => s.findings.map((f) => ({ skill: s.name, ...f })));
  const counts = { error: 0, warn: 0, info: 0 };
  for (const f of findings) counts[f.severity]++;
  const budget = estimateListing(linted, { budgetChars: config.listingBudgetChars, contextTokens: config.contextTokens });
  const shadows = homedir ? findShadows(linted.map((s) => s.name), personalLevels(homedir)) : [];
  return { skills: linted.length, findings, counts, budget, shadows };
}

module.exports = { inspectLibrary };
