import { AGENTS, type ProjectReport, type TargetReport } from './store';
import { agentState, isVerified, isWorking, type Tone } from './agent-status';

/** How a project reads at a glance, how projects are grouped by folder, and how they are filtered. */
export type ProjectFilter = 'all' | 'attention' | 'unverified';
/** The worst thing about a project: something broken, something pointing elsewhere, all fine, or nothing wired. */
export type Health = 'fault' | 'caution' | 'ok' | 'none';

export interface AgentChip { id: string; name: string; tone: Tone; text: string }
export interface ProjectSummary {
  health: Health; text: string; agents: AgentChip[];
  /** Agents that reach skills now, and how many of them the tool has not confirmed. */
  working: number; unverified: number; lastVerified: string | null;
}
export interface ProjectRow { report: ProjectReport; summary: ProjectSummary }
export interface ProjectGroup { key: string; label: string; folder: string; rows: ProjectRow[] }

const RANK: Record<Health, number> = { fault: 3, caution: 2, ok: 1, none: 0 };
export function worstHealth(items: Health[]): Health { return items.reduce<Health>((a, h) => RANK[h] > RANK[a] ? h : a, 'none'); }
export const needsAttention = (h: Health) => h === 'fault' || h === 'caution';

export function summarise(report: ProjectReport): ProjectSummary {
  if (report.state !== 'available') {
    const text = report.warnings[0] || (report.state === 'missing' ? 'This folder no longer exists.' : 'This folder could not be read.');
    return { health: 'fault', text, agents: [], working: 0, unverified: 0, lastVerified: null };
  }
  const wired = report.targets.filter(t => t.feeds !== 'none');
  const agents: AgentChip[] = wired.map(t => ({ id: t.id, name: `${AGENTS[t.id] || t.id}${t.feeds === 'set' && t.set ? ` · ${t.set}` : ''}`, ...agentState(t) }));
  const onSet = wired.filter(t => t.feeds === 'set'), onLibrary = wired.filter(t => t.feeds === 'library');
  const faults = agents.filter(a => a.tone === 'fault'), cautions = agents.filter(a => a.tone === 'caution');
  const health: Health = faults.length ? 'fault' : cautions.length ? 'caution' : agents.length ? 'ok' : 'none';
  const worst = faults.length ? faults : cautions;
  const text = worst.length ? worst[0].text + (worst.length > 1 ? ` (and ${worst.length - 1} more)` : '')
    : agents.length ? (agents.every(a => a.tone === 'live') ? readsText(onSet.map(t => t.set), onLibrary.length > 0) : 'Set up') : 'No agents wired';
  const working = wired.filter(isWorking);
  const times = wired.map(t => t.verification?.at).filter((x): x is string => !!x).sort();
  return { health, text, agents, working: working.length, unverified: working.filter(t => !isVerified(t)).length, lastVerified: times.length ? times[times.length - 1] : null };
}
export const projectRow = (report: ProjectReport): ProjectRow => ({ report, summary: summarise(report) });

/** Plain words for the Verified column. Dates are formatted by the caller's locale. */
export function verifiedText(s: ProjectSummary, when: (iso: string) => string) {
  if (!s.working) return '';
  if (!s.unverified) return `Verified ${s.lastVerified ? when(s.lastVerified) : ''}`.trim();
  return s.lastVerified ? `${s.unverified} of ${s.working} not verified` : 'Not checked';
}

/** Agents a bulk check would ask: they reach skills now, and the tool has not confirmed them (or only before the skills changed). */
export function verifiableTargets(report: ProjectReport) {
  return report.state === 'available' ? report.targets.filter(t => isWorking(t) && !isVerified(t)) : [];
}

/** How much of a list is ticked: for a select-all box that can sit half way. */
export type PickState = 'none' | 'some' | 'all';
export function pickState(ids: string[], picked: ReadonlySet<string>): PickState {
  const n = ids.filter(id => picked.has(id)).length;
  return n === 0 ? 'none' : n === ids.length ? 'all' : 'some';
}
/** A new selection with these ids ticked or cleared; the old one is left alone. */
export function withPicked(picked: ReadonlySet<string>, ids: string[], on: boolean): Set<string> {
  const next = new Set(picked);
  for (const id of ids) { if (on) next.add(id); else next.delete(id); }
  return next;
}

export function matchesProjectFilter(row: ProjectRow, filter: ProjectFilter) {
  return filter === 'all' ? true : filter === 'attention' ? needsAttention(row.summary.health) : row.summary.unverified > 0;
}
export function matchesProjectQuery(report: ProjectReport, query: string) {
  const q = query.trim().toLowerCase(); if (!q) return true;
  return `${report.project.name} ${report.project.path}`.toLowerCase().includes(q);
}
export function projectCounts(rows: ProjectRow[]) {
  return { all: rows.length, attention: rows.filter(r => needsAttention(r.summary.health)).length, unverified: rows.filter(r => r.summary.unverified > 0).length };
}

/** The folder a project sits in, split into parts, whichever way the path is written. */
function parentParts(path: string) {
  const parts = path.split(/[\\/]+/).filter((x, i, all) => x !== '' || i === 0 && all.length > 1);
  parts.pop();
  return parts;
}

/**
 * Projects under one folder form a group, headed by the last two parts of that folder. Two different folders that would
 * share a heading are shown by full path instead, so a heading never stands for two places.
 */
export function groupRows(rows: ProjectRow[]): ProjectGroup[] {
  const groups = new Map<string, ProjectGroup>();
  for (const row of rows) {
    const path = row.report.project.path, parts = parentParts(path), sep = path.includes('\\') ? '\\' : '/';
    const key = parts.join('/').toLowerCase();
    const folder = parts.length ? parts.join(sep) : sep;
    // A drive letter or a leading slash is not a folder name, so D:\Repos is headed Repos. Only a project sitting directly
    // in a drive root is left with the drive, because it has nothing else to be named by.
    const named = parts.filter((p, i) => !(i === 0 && (p === '' || /^[A-Za-z]:$/.test(p))));
    const label = named.length ? named.slice(-2).join(sep) : (parts.join(sep) || sep);
    const group = groups.get(key) ?? { key, label, folder, rows: [] };
    group.rows.push(row); groups.set(key, group);
  }
  const list = [...groups.values()];
  const seen = new Map<string, number>();
  for (const g of list) seen.set(g.label.toLowerCase(), (seen.get(g.label.toLowerCase()) || 0) + 1);
  for (const g of list) if ((seen.get(g.label.toLowerCase()) || 0) > 1) g.label = g.folder;
  const byName = (a: ProjectRow, b: ProjectRow) => a.report.project.name.localeCompare(b.report.project.name, 'en') || a.report.project.path.localeCompare(b.report.project.path, 'en');
  for (const g of list) g.rows.sort(byName);
  return list.sort((a, b) => a.label.localeCompare(b.label, 'en') || a.key.localeCompare(b.key, 'en'));
}
export const groupHealth = (g: ProjectGroup) => worstHealth(g.rows.map(r => r.summary.health));
export const groupAttention = (g: ProjectGroup) => g.rows.filter(r => needsAttention(r.summary.health)).length;

export interface CheckItem { projectId: string; target: string }
/**
 * Every working agent in these projects that the tool has not confirmed, leaving out checks already waiting in the review
 * sheet. `only` narrows which agents count, for example only those that read the library through a link.
 */
export function pendingChecks(reports: ProjectReport[], waiting: (item: CheckItem) => boolean, only: (t: TargetReport) => boolean = () => true): CheckItem[] {
  return reports
    .flatMap(r => verifiableTargets(r).filter(only).map(t => ({ projectId: r.project.id, target: t.id })))
    .filter(item => !waiting(item));
}

/** What an all-fine project reads, in a few words: the library, one set, several sets, or the library and a set. */
function readsText(sets: (string | null)[], alsoLibrary: boolean) {
  if (!sets.length) return 'Reads the library';
  if (alsoLibrary) return 'Reads the library and sets';
  const one = new Set(sets);
  return one.size === 1 ? `Reads the set ${sets[0]}` : 'Reads sets';
}
