import { describe, expect, it } from 'vitest';
import { isGitLocation, matchesFilter, matchesQuery, needsAttention, sourceCounts, sourceLabel, sourceStatus, suggestName } from './source-status';
import type { Source } from './store';

const src = (over: Partial<Source>): Source => ({ id: 'x', key: 'x', name: 'x', kind: 'git', location: 'https://example.com/x.git', root: '', state: 'available', revision: null, count: 3, rejectionCount: 0, error: null, ...over });

describe('source status', () => {
  it('names the vault for people and counts skills in plain words', () => {
    expect(sourceLabel(src({ kind: 'primary', name: 'vault' }))).toBe('Your vault');
    expect(sourceStatus(src({ count: 1 }))).toBe('1 skill');
    expect(sourceStatus(src({ count: 41 }))).toBe('41 skills');
    expect(sourceStatus(src({ state: 'not-fetched' }))).toBe('Not downloaded yet');
  });

  it('treats any source that cannot supply skills as needing attention', () => {
    expect(needsAttention(src({}))).toBe(false);
    for (const state of ['missing', 'not-fetched', 'unreadable', 'rejected'] as const) expect(needsAttention(src({ state }))).toBe(true);
  });

  it('filters and counts', () => {
    const list = [src({ id: 'a' }), src({ id: 'b', state: 'not-fetched' }), src({ id: 'c', state: 'missing' })];
    expect(list.filter(s => matchesFilter(s, 'all')).length).toBe(3);
    expect(list.filter(s => matchesFilter(s, 'attention')).map(s => s.id)).toEqual(['b', 'c']);
    expect(list.filter(s => matchesFilter(s, 'not-fetched')).map(s => s.id)).toEqual(['b']);
    expect(sourceCounts(list)).toEqual({ all: 3, attention: 2, notFetched: 1 });
  });

  it('searches by name, location and kind, ignoring case and spaces at the ends', () => {
    const team = src({ name: 'Team-Skills', location: 'https://example.com/team/skills.git' });
    expect(matchesQuery(team, '  team ')).toBe(true);
    expect(matchesQuery(team, 'EXAMPLE.COM')).toBe(true);
    expect(matchesQuery(team, 'git')).toBe(true);
    expect(matchesQuery(team, 'folder')).toBe(false);
    expect(matchesQuery(src({ kind: 'primary', name: 'vault' }), 'your vault')).toBe(true);
    expect(matchesQuery(team, '')).toBe(true);
  });

  it('tells a Git address from a folder, and suggests a name for either', () => {
    expect(isGitLocation('https://github.com/x/y.git')).toBe(true);
    expect(isGitLocation(' git@github.com:x/y.git')).toBe(true);
    expect(isGitLocation('ssh://host/x')).toBe(true);
    expect(isGitLocation('D:\\Repos\\my-skills')).toBe(false);
    expect(isGitLocation('/home/me/skills')).toBe(false);
    expect(suggestName('https://github.com/x/y.git')).toBe('y');
    expect(suggestName('git@github.com:x/skills.git')).toBe('skills');
    expect(suggestName('D:\\Repos\\my-skills\\')).toBe('my-skills');
    expect(suggestName('')).toBe('');
  });
});
