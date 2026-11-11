'use strict';

/**
 * How much of the skill listing an agent will actually see.
 *
 * Claude Code always lists every skill NAME, but trims DESCRIPTIONS to a budget
 * of about 1% of the model's context window, dropping the least-used first.
 * Without descriptions the agent cannot choose a skill on its own, although
 * calling it by name still works.
 *
 * We cannot know which skills are least used, so this assumes the best case
 * (shortest descriptions kept first). "dropped" is therefore a floor: at least
 * that many descriptions will not be shown.
 */
const DEFAULT_CONTEXT_TOKENS = 200000;
const BUDGET_FRACTION = 0.01;
const CHARS_PER_TOKEN = 4;
const PER_ENTRY_CAP = 1536;

function estimateListing(skills, { budgetChars, contextTokens = DEFAULT_CONTEXT_TOKENS, perEntryCap = PER_ENTRY_CAP } = {}) {
  const budget = budgetChars ?? Math.round(contextTokens * BUDGET_FRACTION * CHARS_PER_TOKEN);
  const lengths = skills.map((s) => Math.min((s.description || '').length, perEntryCap));
  const described = lengths.filter((n) => n > 0).sort((a, b) => a - b);
  let used = 0, kept = 0;
  for (const n of described) { if (used + n > budget) break; used += n; kept++; }
  const descriptionChars = lengths.reduce((a, n) => a + n, 0);
  return {
    entries: skills.length,
    withoutDescription: lengths.filter((n) => n === 0).length,
    descriptionChars,
    budgetChars: budget,
    kept,
    dropped: described.length - kept,
    fits: descriptionChars <= budget,
  };
}

module.exports = { estimateListing, DEFAULT_CONTEXT_TOKENS, PER_ENTRY_CAP };
