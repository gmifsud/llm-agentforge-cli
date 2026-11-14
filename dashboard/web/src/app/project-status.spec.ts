import { describe, expect, it } from 'vitest';
import { groupAttention, groupHealth, groupRows, matchesProjectFilter, matchesProjectQuery, pendingChecks, pickState, projectCounts, projectRow, summarise, verifiableTargets, verifiedText, withPicked } from './project-status';
import type { Feeds, ProjectReport, TargetReport } from './store';

const target = (id: string, feeds: Feeds, over: Partial<TargetReport> = {}): TargetReport => ({
  id, dir: `.${id}`, doc: 'X.md', docExists: true, optIn: false, copy: null, adoptable: null, verification: null, kind: 'link', health: 'link',
  resolvedTarget: null, feeds, set: null, entries: null, match: 'matches', ...over,
});
const verified = (stale = false) => ({ level: 'verified' as const, tool: 't', detail: '', at: '2026-11-12T10:00:00.000Z', stale });
const report = (path: string, targets: TargetReport[] = [], over: Partial<ProjectReport> = {}): ProjectReport => ({
  project: { id: path, name: path.split(/[\\/]/).pop()!, path, origin: 'saved', local: true }, readAt: '', deployment: { root: '', origin: '', warnings: [] },
  targets, state: 'available', warnings: [], ...over,
});

describe('a project at a glance', () => {
  it('is broken, points elsewhere, is fine, or has nothing wired, worst first', () => {
    expect(summarise(report('D:\\a', [target('claude', 'broken'), target('codex', 'vault')])).health).toBe('fault');
    expect(summarise(report('D:\\a', [target('claude', 'library'), target('codex', 'vault')])).health).toBe('caution');
    expect(summarise(report('D:\\a', [target('claude', 'library')])).health).toBe('ok');
    expect(summarise(report('D:\\a', [target('claude', 'none')])).health).toBe('none');
    expect(summarise(report('D:\\a', [target('claude', 'none')])).text).toBe('No agents wired');
  });

  it('says what is wrong, and how many more are', () => {
    const s = summarise(report('D:\\a', [target('claude', 'vault'), target('codex', 'elsewhere'), target('gemini', 'library')]));
    expect(s.text).toBe('Reads your vault only (and 1 more)');
    expect(s.agents.map(a => a.name)).toEqual(['Claude Code', 'Codex', 'Gemini CLI']);
  });

  it('a folder that is gone is a fault with its own reason', () => {
    const s = summarise(report('D:\\gone', [], { state: 'missing', warnings: ['This folder no longer exists.'] }));
    expect(s.health).toBe('fault'); expect(s.text).toBe('This folder no longer exists.');
  });

  it('counts working agents the tool has not confirmed, and ignores stale confirmations', () => {
    const none = summarise(report('D:\\a', [target('claude', 'library'), target('codex', 'library')]));
    expect([none.working, none.unverified, none.lastVerified]).toEqual([2, 2, null]);
    const one = summarise(report('D:\\a', [target('claude', 'library', { verification: verified() }), target('codex', 'library')]));
    expect([one.working, one.unverified]).toEqual([2, 1]);
    const stale = summarise(report('D:\\a', [target('claude', 'library', { verification: verified(true) })]));
    expect(stale.unverified).toBe(1); expect(stale.lastVerified).toBe('2026-11-12T10:00:00.000Z');
    expect(summarise(report('D:\\a', [target('claude', 'vault')])).working).toBe(0);
  });

  it('words the Verified column', () => {
    const when = () => 'then';
    expect(verifiedText(summarise(report('D:\\a', [target('claude', 'vault')])), when)).toBe('');
    expect(verifiedText(summarise(report('D:\\a', [target('claude', 'library')])), when)).toBe('Not checked');
    expect(verifiedText(summarise(report('D:\\a', [target('claude', 'library', { verification: verified() }), target('codex', 'library')])), when)).toBe('1 of 2 not verified');
    expect(verifiedText(summarise(report('D:\\a', [target('claude', 'library', { verification: verified() })])), when)).toBe('Verified then');
  });
});

describe('an agent that reads a set', () => {
  const onSet = (id: string, set: string) => target(id, 'set', { set });
  it('shows its set in its chip, and counts as working so it can be checked', () => {
    const s = summarise(report('/work/a', [onSet('codex', 'offshore')]));
    expect(s.agents.map(a => [a.name, a.text, a.tone])).toEqual([['Codex · offshore', 'Reads the set offshore', 'live']]);
    expect(s.health).toBe('ok');
    expect([s.working, s.unverified]).toEqual([1, 1]);
    expect(verifiableTargets(report('/work/a', [onSet('codex', 'offshore')])).map(t => t.id)).toEqual(['codex']);
  });

  it('the project says what it reads: a set, several sets, the library, or the library and sets', () => {
    const text = (...t: TargetReport[]) => summarise(report('/work/a', t)).text;
    expect(text(onSet('codex', 'offshore'))).toBe('Reads the set offshore');
    expect(text(onSet('codex', 'offshore'), onSet('claude', 'offshore'))).toBe('Reads the set offshore');
    expect(text(onSet('codex', 'offshore'), onSet('claude', 'backend'))).toBe('Reads sets');
    expect(text(target('codex', 'library'))).toBe('Reads the library');
    expect(text(target('codex', 'library'), onSet('claude', 'offshore'))).toBe('Reads the library and sets');
  });
});

describe('filters and counts', () => {
  const rows = [
    projectRow(report('D:\\r\\ok', [target('claude', 'library', { verification: verified() })])),
    projectRow(report('D:\\r\\drift', [target('claude', 'vault')])),
    projectRow(report('D:\\r\\new', [target('claude', 'library')])),
    projectRow(report('D:\\r\\bare', [])),
  ];
  it('narrows to what needs attention or has not been checked', () => {
    expect(rows.filter(r => matchesProjectFilter(r, 'attention')).map(r => r.report.project.name)).toEqual(['drift']);
    expect(rows.filter(r => matchesProjectFilter(r, 'unverified')).map(r => r.report.project.name)).toEqual(['new']);
    expect(projectCounts(rows)).toEqual({ all: 4, attention: 1, unverified: 1 });
  });
  it('searches name and path, ignoring case', () => {
    expect(matchesProjectQuery(rows[1].report, ' DRIFT ')).toBe(true);
    expect(matchesProjectQuery(rows[1].report, 'd:\\r')).toBe(true);
    expect(matchesProjectQuery(rows[1].report, 'nope')).toBe(false);
  });
});

describe('what a bulk action would touch', () => {
  it('lists working agents that are not confirmed, and none for a folder that cannot be read', () => {
    const r = report('D:\\a', [
      target('claude', 'library'),                                                 // working, never asked
      target('codex', 'library', { verification: verified() }),                    // confirmed
      target('gemini', 'library', { verification: verified(true) }),               // confirmed before the skills changed
      target('cursor', 'vault'),                                                   // not reading the library: nothing to check
    ]);
    expect(verifiableTargets(r).map(t => t.id)).toEqual(['claude', 'gemini']);
    expect(verifiableTargets(report('D:\\gone', [target('claude', 'library')], { state: 'missing' }))).toEqual([]);
  });

  it('reports how much of a list is ticked, and builds a new selection without changing the old', () => {
    const ids = ['a', 'b', 'c'];
    expect(pickState(ids, new Set())).toBe('none');
    expect(pickState(ids, new Set(['b']))).toBe('some');
    expect(pickState(ids, new Set(['a', 'b', 'c', 'z']))).toBe('all');
    expect(pickState([], new Set(['a']))).toBe('none');
    const before = new Set(['a']);
    const after = withPicked(before, ['b', 'c'], true);
    expect([...before]).toEqual(['a']); expect([...after].sort()).toEqual(['a', 'b', 'c']);
    expect([...withPicked(after, ['a', 'c'], false)]).toEqual(['b']);
  });
});

describe('checking every agent', () => {
  const reports = [
    report('/work/a', [target('claude', 'library'), target('codex', 'library', { verification: verified() })]),
    report('/work/b', [target('claude', 'vault'), target('gemini', 'library')]),
    report('/work/gone', [target('claude', 'library')], { state: 'missing' }),
  ];
  it('lists every working agent the tool has not confirmed, across projects', () => {
    expect(pendingChecks(reports, () => false)).toEqual([{ projectId: '/work/a', target: 'claude' }, { projectId: '/work/b', target: 'gemini' }]);
  });
  it('leaves out checks already waiting, and can be narrowed to some agents', () => {
    expect(pendingChecks(reports, i => i.target === 'claude')).toEqual([{ projectId: '/work/b', target: 'gemini' }]);
    expect(pendingChecks(reports, () => false, t => t.id === 'gemini')).toEqual([{ projectId: '/work/b', target: 'gemini' }]);
    expect(pendingChecks([], () => false)).toEqual([]);
  });
});

describe('grouping by folder', () => {
  const row = (path: string, feeds: Feeds = 'library') => projectRow(report(path, [target('claude', feeds)]));

  it('heads each group with the last two parts of its folder, projects sorted by name', () => {
    const groups = groupRows([row('D:\\Repos\\LLM\\zeta'), row('D:\\Repos\\Work\\app'), row('D:\\Repos\\LLM\\alpha')]);
    expect(groups.map(g => g.label)).toEqual(['Repos\\LLM', 'Repos\\Work']);
    expect(groups[0].rows.map(r => r.report.project.name)).toEqual(['alpha', 'zeta']);
    expect(groups[0].folder).toBe('D:\\Repos\\LLM');
  });

  it('reads posix paths and ignores letter case and trailing slashes in the folder', () => {
    const groups = groupRows([row('/home/me/code/a'), row('/home/me/code/b/'), row('/HOME/me/Code/c')]);
    expect(groups.length).toBe(1);
    expect(groups[0].label).toBe('me/code');
    expect(groups[0].rows.length).toBe(3);
  });

  it('never lets one heading stand for two folders', () => {
    const groups = groupRows([row('C:\\x\\Repos\\LLM\\a'), row('D:\\y\\Repos\\LLM\\b')]);
    expect(groups.map(g => g.label).sort()).toEqual(['C:\\x\\Repos\\LLM', 'D:\\y\\Repos\\LLM']);
  });

  it('puts a project in the drive root under the root, and reports a group worst-first', () => {
    const groups = groupRows([row('D:\\solo', 'vault'), row('D:\\other', 'library')]);
    expect(groups.length).toBe(1); expect(groups[0].label).toBe('D:');
    expect(groupHealth(groups[0])).toBe('caution'); expect(groupAttention(groups[0])).toBe(1);
  });

  it('does not show the drive letter: D:\\Repos reads as Repos', () => {
    expect(groupRows([row('D:\\Repos\\app')])[0].label).toBe('Repos');
    expect(groupRows([row('D:\\Repos\\LLM\\app')])[0].label).toBe('Repos\\LLM');
    expect(groupRows([row('/repos/app')])[0].label).toBe('repos');
    // A project directly in the drive root has nothing but the drive to be named by.
    expect(groupRows([row('D:\\solo')])[0].label).toBe('D:');
    expect(groupRows([row('/solo')])[0].label).toBe('/');
    // The same folder name on two drives is two places, so they are told apart by their full path.
    expect(groupRows([row('C:\\Repos\\a'), row('D:\\Repos\\b')]).map(g => g.label).sort()).toEqual(['C:\\Repos', 'D:\\Repos']);
    // The full path is still available for the tooltip.
    expect(groupRows([row('D:\\Repos\\app')])[0].folder).toBe('D:\\Repos');
  });

  it('is deterministic whatever order the projects arrive in', () => {
    const list = [row('D:\\R\\B\\1'), row('D:\\R\\A\\2'), row('D:\\R\\B\\0'), row('D:\\R\\A\\1')];
    const a = groupRows(list), b = groupRows([...list].reverse());
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });
});
