import { describe, expect, it } from 'vitest';
import { fitBudget, globToRegExp, libraryEntries, resolveRules, type LibraryEntry } from './set-rules';
import type { Catalog, SetRule } from './store';

// The same library and rules as tests/sets.test.js, so the page and the server cannot drift apart unnoticed.
const lib: LibraryEntry[] = [
  { name: 'orcaflex-line-wizard', source: 'vault', category: 'offshore-engineering', chars: 100 },
  { name: 'orcaflex-batch-manager', source: 'vault', category: 'offshore-engineering', chars: 100 },
  { name: 'mooring-design', source: 'vault', category: 'offshore-engineering', chars: 100 },
  { name: 'github-actions', source: 'vault', category: 'devtools', chars: 100 },
  { name: 'tdd', source: 'obra', category: '', chars: 100 },
  { name: 'brainstorming', source: 'obra', category: '', chars: 100 },
];
const r = (text: string): SetRule => { const exclude = text.startsWith('-'); const [type, ...v] = (exclude ? text.slice(1) : text).split(':'); return { type: type as SetRule['type'], value: v.join(':'), ...(exclude ? { exclude: true } : {}) }; };
const names = (rules: string[], library = lib) => resolveRules(rules.map(r), library).entries.map(e => e.name);

describe('set rules in the page', () => {
  it('a pattern uses * and ? only, ignores case, and must match the whole name', () => {
    const m = (p: string, s: string) => globToRegExp(p).test(s);
    expect(m('orcaflex-*', 'orcaflex-line-wizard') && m('ORCAFLEX-*', 'orcaflex-x')).toBe(true);
    expect(m('orcaflex-line-wiz?rd', 'orcaflex-line-wizard')).toBe(true);
    expect(m('flex', 'orcaflex')).toBe(false);
    expect(m('a.c', 'abc')).toBe(false);
    expect(m('a+b(c)', 'a+b(c)')).toBe(true);
  });

  it('rules apply in order: include adds, exclude removes, a later include puts a skill back', () => {
    const res = resolveRules(['category:offshore-engineering', 'name:orcaflex-*', 'skill:tdd', '-skill:orcaflex-batch-manager'].map(r), lib);
    expect(res.entries.map(e => e.name)).toEqual(['mooring-design', 'orcaflex-line-wizard', 'tdd']);
    expect(res.rules.map(x => [x.matched, x.added, x.removed])).toEqual([[3, 3, 0], [2, 0, 0], [1, 1, 0], [1, 0, 1]]);
    expect(names(['category:offshore-engineering', '-skill:mooring-design', 'skill:mooring-design'])).toContain('mooring-design');
    expect(names(['skill:mooring-design', '-category:offshore-engineering'])).not.toContain('mooring-design');
    expect(names(['-skill:tdd'])).toEqual([]);
  });

  it('matching ignores case and reads source and category; the order the library is listed in does not matter', () => {
    expect(names(['category:OFFSHORE-Engineering']).length).toBe(3);
    expect(names(['source:OBRA'])).toEqual(['brainstorming', 'tdd']);
    expect(names(['skill:TDD'])).toEqual(['tdd']);
    expect(names(['source:vault'], [...lib].reverse())).toEqual(names(['source:vault']));
  });

  it('a rule that selects nothing is reported; an exclude that selects nothing is harmless', () => {
    const res = resolveRules(['skill:nope', 'name:zzz-*', 'category:none', 'source:nowhere', 'skill:tdd'].map(r), lib);
    expect(res.unmatched.map(x => `${x.type}:${x.value}`)).toEqual(['skill:nope', 'name:zzz-*', 'category:none', 'source:nowhere']);
    expect(resolveRules([r('-skill:nothing')], lib).unmatched).toEqual([]);
  });
});

describe('what an agent will see of a set', () => {
  it('matches the server: shortest descriptions first, fits means the total is within the budget', () => {
    const small = fitBudget([40, 40], 100);
    expect([small.entries, small.kept, small.dropped, small.fits]).toEqual([2, 2, 0, true]);
    const big = fitBudget([60, 60, 60], 100);
    expect([big.entries, big.kept, big.dropped, big.fits]).toEqual([3, 1, 2, false]);
    expect(fitBudget([0, 0], 100).fits).toBe(true);
    expect(fitBudget([5000], 8000).usedChars).toBe(1536);
  });
});

describe('the library as the editor sees it', () => {
  it('lists the winning skills with their source, category and description length', () => {
    const c = {
      winnerIds: ['a', 'c'],
      sources: [{ id: 'v', kind: 'primary', name: 'Primary vault' }, { id: 'o', kind: 'git', name: 'obra' }],
      skills: [
        { id: 'a', name: 'sql-review', sourceId: 'v', relativePath: 'sql-review', category: 'data', descriptionChars: 22 },
        { id: 'b', name: 'sql-review', sourceId: 'o', relativePath: 'sql-review', category: 'other', descriptionChars: 9 },
        { id: 'c', name: 'tdd', sourceId: 'o', relativePath: 'tdd' },
      ],
    } as unknown as Catalog;
    expect(libraryEntries(c)).toEqual([
      { name: 'sql-review', source: 'vault', category: 'data', chars: 22 },
      { name: 'tdd', source: 'obra', category: '', chars: 0 },
    ]);
  });
});
