import type { Source } from './store';

/** How a source is named and described, shared by the wiring board and the fleet view. */
export type SourceFilter = 'all' | 'attention' | 'not-fetched';

export function sourceLabel(src: Source) { return src.kind === 'primary' ? 'Your vault' : src.name; }

export function sourceStatus(s: Source) {
  if (s.state === 'available') return s.count === 1 ? '1 skill' : `${s.count ?? 0} skills`;
  return ({ missing: 'Folder is missing', 'not-fetched': 'Not downloaded yet', unreadable: 'Cannot be read', rejected: 'Outside the allowed folders' } as Record<string, string>)[s.state] || s.state;
}

/** A source that cannot supply its skills right now. */
export function needsAttention(s: Source) { return s.state !== 'available'; }

export function matchesFilter(s: Source, filter: SourceFilter) {
  return filter === 'all' ? true : filter === 'attention' ? needsAttention(s) : s.state === 'not-fetched';
}

/** Case-insensitive match on what a person would type: its name, where it lives, or its kind. */
export function matchesQuery(s: Source, query: string) {
  const q = query.trim().toLowerCase(); if (!q) return true;
  const kind = s.kind === 'git' ? 'git' : s.kind === 'primary' ? 'vault' : 'folder';
  return `${sourceLabel(s)} ${s.location} ${kind}`.toLowerCase().includes(q);
}

export function sourceCounts(sources: Source[]) {
  return { all: sources.length, attention: sources.filter(needsAttention).length, notFetched: sources.filter(s => s.state === 'not-fetched').length };
}

/** A Git address rather than a folder: a web or ssh URL, or the `git@host:path` form. */
export function isGitLocation(location: string) { return /^(https?:\/\/|ssh:\/\/|git@[^/:]+:)/i.test(location.trim()); }
/** The name a source gets when none is typed: the last part of its address, without `.git`. */
export function suggestName(location: string) { return location.trim().replace(/[\\/]+$/, '').split(/[\\/:]/).pop()?.replace(/\.git$/i, '') || ''; }
