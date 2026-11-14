import type { Catalog, SetRule } from './store';

/**
 * The rules of a skill set, resolved in the page so the editor can show the result as you type. This is the same logic as
 * src/domain/sets.js and src/discovery/listing-budget.js, kept in step by tests that use the same cases; the server decides
 * what is actually saved, and its preview in the review sheet is the final word.
 */
export interface LibraryEntry { name: string; source: string; category: string; chars: number }
export interface RuleInfo extends SetRule { matched: number; added: number; removed: number }
export interface Resolved { entries: LibraryEntry[]; rules: RuleInfo[]; unmatched: SetRule[] }
export interface Fit { entries: number; kept: number; dropped: number; fits: boolean; usedChars: number; budgetChars: number }

export const RULE_KINDS: { type: SetRule['type']; label: string; hint: string }[] = [
  { type: 'category', label: 'A category', hint: 'every skill whose own category says so' },
  { type: 'name', label: 'A name pattern', hint: 'for example orcaflex-*  (* is any run of characters, ? is one)' },
  { type: 'source', label: 'A source', hint: 'every skill the library took from one source' },
  { type: 'skill', label: 'One skill', hint: 'a skill picked by hand' },
];

const lc = (s: string | undefined) => (s ?? '').toLowerCase();
const byName = (a: LibraryEntry, b: LibraryEntry) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
const PER_ENTRY_CAP = 1536;

/** * is any run of characters, ? one character, the rest is literal; case does not matter; the whole name must match. */
export function globToRegExp(pattern: string) {
  const body = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.');
  return new RegExp(`^${body}$`, 'i');
}

export function ruleMatches(rule: SetRule, e: LibraryEntry) {
  switch (rule.type) {
    case 'skill': return lc(e.name) === lc(rule.value);
    case 'name': return globToRegExp(rule.value).test(e.name);
    case 'source': return lc(e.source) === lc(rule.value);
    case 'category': return lc(e.category) === lc(rule.value);
    default: return false;
  }
}

/** Rules apply in order: an include adds, an exclude removes, and the last rule that touches a skill wins. */
export function resolveRules(rules: SetRule[], library: LibraryEntry[]): Resolved {
  const sorted = [...library].sort(byName);
  const chosen = new Map<string, LibraryEntry>();
  const info: RuleInfo[] = [];
  for (const rule of rules) {
    const hit = sorted.filter(e => ruleMatches(rule, e));
    let added = 0, removed = 0;
    for (const e of hit) {
      const key = lc(e.name);
      if (rule.exclude) { if (chosen.delete(key)) removed++; } else if (!chosen.has(key)) { chosen.set(key, e); added++; }
    }
    info.push({ ...rule, matched: hit.length, added, removed });
  }
  return {
    entries: [...chosen.values()].sort(byName),
    rules: info,
    unmatched: info.filter(r => !r.exclude && r.matched === 0).map(({ type, value }) => ({ type, value })),
  };
}

/** The library's winning skills, each with the source it came from ("vault" for your primary vault), its category and description length. */
export function libraryEntries(c: Catalog): LibraryEntry[] {
  const winners = new Set(c.winnerIds);
  const sourceKey = (id: string) => { const s = c.sources.find(x => x.id === id); return !s ? '' : s.kind === 'primary' ? 'vault' : s.name; };
  return c.skills.filter(s => winners.has(s.id)).map(s => ({ name: s.name, source: sourceKey(s.sourceId), category: s.category ?? '', chars: s.descriptionChars ?? 0 }));
}

/** How much of a listing an agent will see: the shortest descriptions are kept first, until the budget is used. */
export function fitBudget(chars: number[], budgetChars: number): Fit {
  const lengths = chars.map(n => Math.min(n, PER_ENTRY_CAP));
  const described = lengths.filter(n => n > 0).sort((a, b) => a - b);
  let used = 0, kept = 0;
  for (const n of described) { if (used + n > budgetChars) break; used += n; kept++; }
  const total = lengths.reduce((a, n) => a + n, 0);
  return { entries: lengths.length, kept, dropped: described.length - kept, fits: total <= budgetChars, usedChars: total, budgetChars };
}

export function ruleText(rule: SetRule) { return `${rule.type} ${rule.value}`; }
