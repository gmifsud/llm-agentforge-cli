import { TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { provideHttpClientTesting, HttpTestingController } from '@angular/common/http/testing';
import { provideRouter } from '@angular/router';
import { Store, type Catalog } from './store';
import { Library } from './library';
import { KeptIssueRow } from './kept-issues';
import { ClashRow, ClashQueue } from './clash-queue';
import { LibraryCard } from './library-card';
import { CHANGES_PREFERENCE_KEY } from './changes-presentation';

const library = { path: 'lib', built: true, builtAt: '', invalid: false, size: 1, add: [], remove: [], change: [], inSync: true };
const catalog: Catalog = {
  generation: 'g1', startedAt: '', completedAt: '', status: 'complete', mergeAvailable: true, library, projects: [], health: null, sourceOrder: ['source'], sourceOrderExplicit: false, sinceLastBuild: null, sets: [], setAside: [],
  sources: [{ id: 'source', key: 'vault', kind: 'primary', name: 'Primary vault', location: 'fixture', root: 'fixture', state: 'available', revision: null, count: 1, rejectionCount: 0, error: null }],
  skills: [{ id: 'skill', sourceId: 'source', name: 'test-skill', relativePath: 'test-skill' }],
  winnerIds: ['skill'], collisions: [], keptIssues: [], rejected: [], warnings: [],
};
const ok = (title: string) => ({ kind: 'library.rebuild', title, lines: [], conflicts: [], ok: true });

describe('client state', () => {
  let store: Store, http: HttpTestingController;
  beforeEach(() => { TestBed.configureTestingModule({ providers: [provideHttpClient(), provideHttpClientTesting(), provideRouter([])] }); store = TestBed.inject(Store); http = TestBed.inject(HttpTestingController); });
  afterEach(() => http.verify());

  it('refresh retains stale rows on failure and pauses document reads', async () => {
    store.catalog.set(catalog);
    const run = store.refresh();
    http.expectOne('/api/v1/context').flush({ readOnly: false, projects: [], platform: 'win32' });
    await Promise.resolve();
    const req = http.expectOne('/api/v1/catalog');
    expect(req.request.method).toBe('GET'); expect(req.request.headers.get('X-Agentforge-Read')).toBe('1');
    req.flush({ error: { message: 'Registry corrupt' } }, { status: 503, statusText: 'Unavailable' });
    await run;
    expect(store.catalog()).toBe(catalog); expect(store.stale()).toBe(true);
    await store.readDocument('skill'); http.expectNone('/api/v1/skills/skill/document?generation=g1');
  });

  it('filter and paging are local and do not issue requests', () => {
    store.catalog.set({ ...catalog, skills: Array.from({ length: 1000 }, (_, i) => ({ id: `s${i}`, name: `skill-${i}`, sourceId: 'source', relativePath: `skill-${i}` })) });
    store.skillQuery.set('skill-99');
    expect(store.filteredSkills().length).toBe(11);
    store.skillQuery.set(''); store.page.set(1); expect(store.visibleSkills().length).toBe(50);
  });

  it('renders instruction HTML as inert text', async () => {
    store.catalog.set(catalog); store.selectSkill('skill');
    store.document.set({ id: 'skill', sourceId: 'source', relativePath: 'test-skill', readAt: new Date().toISOString(), text: '<script>bad()</script><img src="https://example.com/leak">' });
    const fixture = TestBed.createComponent(Library); await fixture.whenStable();
    const host: HTMLElement = fixture.nativeElement;
    expect(host.querySelector('pre')?.textContent).toContain('<script>bad()</script>');
    expect(host.querySelector('pre script, pre img')).toBeNull();
  });

  it('queues changes in pipeline order, collapses duplicates, and previews each with the write headers', async () => {
    store.catalog.set(catalog);
    store.wire('p1', ['claude']);
    store.attach('D:\\skills\\extra', '', '');
    store.rebuild();
    expect(store.tray().map(i => i.change.kind)).toEqual(['source.attach', 'library.rebuild', 'project.wire']);
    expect(store.tray().map(i => i.deferred)).toEqual([false, true, true]);
    const first = http.expectOne('/api/v1/changes/preview');
    expect(first.request.method).toBe('POST');
    expect(first.request.headers.get('X-Agentforge-Write')).toBe('1');
    expect(first.request.body).toEqual({ change: { kind: 'project.wire', args: { projectId: 'p1', targets: ['claude'], writeDocs: true, link: 'auto', repoint: false } } });
    first.flush(ok('Wire'));
    await Promise.resolve(); await Promise.resolve();
    for (const req of http.match('/api/v1/changes/preview')) req.flush(ok('x'));
    await Promise.resolve(); await Promise.resolve();
    for (const req of http.match('/api/v1/changes/preview')) req.flush(ok('x'));
  });

  it('a wire waiting for a queued rebuild is not blocked; a real conflict is', () => {
    store.tray.set([
      { uid: 1, change: { kind: 'library.rebuild' }, preview: ok('Rebuild') as any, error: '', deferred: false },
      { uid: 2, change: { kind: 'project.wire' }, preview: { ...ok('Wire'), ok: false, conflicts: ['The library has not been built yet. Rebuild the library first.'] } as any, error: '', deferred: true },
    ]);
    expect(store.blocked()).toBe(false);
    store.tray.update(l => [l[0], { ...l[1], preview: { ...l[1].preview!, conflicts: ['claude: .claude/skills points somewhere else.'] } }]);
    expect(store.blocked()).toBe(true);
  });

  const settle = async () => { for (let i = 0; i < 6; i++) await Promise.resolve(); };
  const result = (kind: string, title: string, status: string) => ({ kind, title, status, lines: [], message: '' });
  const tray = (...items: [string, any?][]) => store.tray.set(items.map(([kind, args], i) => ({ uid: i + 1, change: { kind, args } as any, preview: ok(`${kind} ${i + 1}`) as any, error: '', deferred: false })));
  const refreshAfter = async (run: Promise<void>) => {
    await settle();
    http.expectOne('/api/v1/context').flush({ readOnly: false, projects: [], platform: 'win32' });
    await settle();
    http.expectOne('/api/v1/catalog').flush(catalog);
    await run;
  };

  it('apply sends one change per request, in order, shows progress, keeps the results, then refreshes', async () => {
    tray(['source.attach', { location: 'D:\\x' }], ['library.rebuild']);
    const run = store.apply();
    expect(store.applyProgress()).toEqual({ done: 0, total: 2 });
    expect(store.activeStep()).toBe(0);
    const first = http.expectOne('/api/v1/changes/apply');
    expect(first.request.body).toEqual({ changes: [{ kind: 'source.attach', args: { location: 'D:\\x' } }] });
    first.flush({ results: [result('source.attach', 'Attach x', 'applied')] });
    await settle();
    expect(store.applyProgress()).toEqual({ done: 1, total: 2 });
    expect(store.results()).toBeNull();
    expect(store.runSteps()[0].result?.status).toBe('applied');
    expect(store.activeStep()).toBe(1);
    expect(store.runSteps()[1].startedAt).not.toBeNull();
    // Presentation and attempts to edit/acknowledge cannot alter an active run.
    store.setTrayHidden(true);
    store.remove(store.tray()[0].uid);
    store.discard(); store.finish(); store.queue({ kind: 'project.add', args: { path: 'D:\\ignored' } });
    expect(store.tray()).toHaveLength(2);
    const second = http.expectOne('/api/v1/changes/apply');
    expect(second.request.body).toEqual({ changes: [{ kind: 'library.rebuild' }] });
    second.flush({ results: [result('library.rebuild', 'Rebuild', 'applied')] });
    await refreshAfter(run);
    expect(store.results()?.map(r => r.status)).toEqual(['applied', 'applied']);
    expect(store.applyProgress()).toBeNull();
    expect(store.activeStep()).toBeNull();
    localStorage.removeItem(CHANGES_PREFERENCE_KEY);
    store.finish();
    expect(store.tray()).toEqual([]);
  });

  it('keeps hidden presentation during preview and enqueue without persisting requests', async () => {
    store.setTrayHidden(true);
    store.queue({ kind: 'library.rebuild' });
    expect(store.trayOpen()).toBe(false);
    http.expectOne('/api/v1/changes/preview').flush(ok('Rebuild'));
    await settle();
    store.queue({ kind: 'project.add', args: { path: 'D:\\fixture' } });
    http.expectOne('/api/v1/changes/preview').flush(ok('Add fixture'));
    await settle();
    expect(store.trayHidden()).toBe(true);
    expect(store.trayOpen()).toBe(false);
    expect(localStorage.getItem(CHANGES_PREFERENCE_KEY)).toBe('hidden');
    expect(store.tray()).toHaveLength(2);
    store.setTrayHidden(false);
    localStorage.removeItem(CHANGES_PREFERENCE_KEY);
  });

  it('requires Done before another batch and preserves prior results and queued source order', async () => {
    tray(['library.rebuild']);
    const run = store.apply();
    http.expectOne('/api/v1/changes/apply').flush({ results: [result('library.rebuild', 'Rebuild', 'applied')] });
    await refreshAfter(run);
    const acknowledged = store.results();
    store.queue({ kind: 'project.add', args: { path: 'D:\\fixture' } });
    store.remove(store.tray()[0].uid); store.discard();
    expect(store.results()).toBe(acknowledged);
    expect(store.tray()).toHaveLength(1);
    expect(store.trayOpen()).toBe(true);
    http.expectNone('/api/v1/changes/preview');
    store.finish();
    store.queue({ kind: 'project.add', args: { path: 'D:\\fixture' } });
    http.expectOne('/api/v1/changes/preview').flush(ok('Add fixture'));
    await settle();
    expect(store.tray()[0].change.kind).toBe('project.add');
    expect(store.results()).toBeNull();
  });

  it('a fetch or a check that fails does not stop the ones after it; any other failure does', async () => {
    tray(['source.fetch', { name: 'down' }], ['source.fetch', { name: 'up' }], ['library.rebuild']);
    let run = store.apply();
    http.expectOne('/api/v1/changes/apply').flush({ results: [result('source.fetch', 'Fetch updates for down', 'failed')] });
    await settle();
    http.expectOne('/api/v1/changes/apply').flush({ results: [result('source.fetch', 'Fetch updates for up', 'applied')] });
    await settle();
    http.expectOne('/api/v1/changes/apply').flush({ results: [result('library.rebuild', 'Rebuild', 'applied')] });
    await refreshAfter(run);
    expect(store.results()?.map(r => r.status)).toEqual(['failed', 'applied', 'applied']);
    store.finish();

    tray(['project.verify', { projectId: 'p1', target: 'gemini' }], ['project.verify', { projectId: 'p1', target: 'claude' }]);
    run = store.apply();
    http.expectOne('/api/v1/changes/apply').flush({ results: [result('project.verify', 'Check Gemini CLI in p1', 'refused')] });
    await settle();
    http.expectOne('/api/v1/changes/apply').flush({ results: [result('project.verify', 'Check Claude Code in p1', 'applied')] });
    await refreshAfter(run);
    expect(store.results()?.map(r => r.status)).toEqual(['refused', 'applied']);
    store.finish();

    // Anything else depends on what came before: nothing after a refusal is sent.
    tray(['source.attach', { location: 'D:\\x' }], ['library.rebuild']);
    run = store.apply();
    http.expectOne('/api/v1/changes/apply').flush({ results: [result('source.attach', 'Attach x', 'refused')] });
    await refreshAfter(run);
    http.expectNone('/api/v1/changes/apply');
    expect(store.results()?.map(r => r.status)).toEqual(['refused', 'skipped']);
    expect(store.results()?.[1].title).toBe('library.rebuild 2');
    expect(store.results()?.[1].message).toMatch(/earlier change did not apply/);
  });

  it('a lost apply response leaves that request uncertain, preserves acknowledged results and skips unsent steps', async () => {
    tray(['project.verify', { projectId: 'p1', target: 'claude' }], ['project.verify', { projectId: 'p2', target: 'claude' }], ['project.verify', { projectId: 'p3', target: 'claude' }]);
    const run = store.apply();
    http.expectOne('/api/v1/changes/apply').flush({ results: [result('project.verify', 'Check Claude Code in p1', 'applied')] });
    await settle();
    http.expectOne('/api/v1/changes/apply').flush({ error: { message: 'down' } }, { status: 503, statusText: 'Unavailable' });
    await refreshAfter(run);
    expect(store.results()?.map(r => r.status)).toEqual(['applied', 'uncertain', 'skipped']);
    expect(store.results()?.[1].message).toMatch(/may have (already )?applied/i);
    expect(store.results()?.[1].message).toMatch(/before.*try.*again/i);
    expect(store.results()?.[2].message).toMatch(/not sent/i);
    expect(store.applyError()).not.toBe('');
    await store.apply();
    http.expectNone('/api/v1/changes/apply');
  });

  const src = (id: string, key: string, kind: 'primary' | 'local' = 'local') => ({ id, key, kind, name: key, location: key, root: key, state: 'available' as const, revision: null, count: 1, rejectionCount: 0, error: null });
  const clashCatalog = (): Catalog => ({
    ...catalog,
    sources: [src('v', 'vault', 'primary'), src('a', 'alpha'), src('b', 'beta')],
    sourceOrder: ['v', 'a', 'b'],
    skills: [
      { id: 'tdd-v', sourceId: 'v', name: 'tdd', relativePath: 'tdd' }, { id: 'tdd-a', sourceId: 'a', name: 'tdd', relativePath: 'tdd' },
      { id: 'x-a', sourceId: 'a', name: 'x', relativePath: 'x' }, { id: 'x-b', sourceId: 'b', name: 'x', relativePath: 'x' },
      { id: 'same-v', sourceId: 'v', name: 'same', relativePath: 'same' }, { id: 'same-b', sourceId: 'b', name: 'same', relativePath: 'same' },
    ],
    winnerIds: ['tdd-a', 'x-a', 'same-v'],
    collisions: [
      { name: 'tdd', winnerId: 'tdd-a', candidateIds: ['tdd-v', 'tdd-a'], preferredSourceId: 'a', kind: 'changed', by: 'choice', stale: true, changedSourceIds: ['v'], identicalIds: [], resolved: false, keptNames: [] },
      { name: 'x', winnerId: 'x-a', candidateIds: ['x-a', 'x-b'], preferredSourceId: null, kind: 'default', by: 'default', stale: false, changedSourceIds: [], identicalIds: [], resolved: false, keptNames: [] },
      { name: 'same', winnerId: 'same-v', candidateIds: ['same-v', 'same-b'], preferredSourceId: null, kind: 'identical', by: 'default', stale: false, changedSourceIds: [], identicalIds: ['same-b'], resolved: false, keptNames: [] },
    ],
  });

  it('sorts clashes by what needs a person: changed first, then default-only; identical and decided never ask', () => {
    store.catalog.set(clashCatalog());
    expect(store.attention().map(c => c.name)).toEqual(['tdd', 'x']);
    expect(store.clashCounts()).toEqual({ identical: 1, decided: 0, needs: 1, changed: 1, total: 3 });
    const by = (id: string) => store.reason(store.skillById(id)!);
    expect([by('tdd-a'), by('tdd-v'), by('x-b'), by('same-b')]).toEqual(['In the library', 'You chose another', 'Lower in the default order', 'Identical to the one in use']);
    store.view.set('attention');
    expect(store.filteredSkills().map(s => s.id).sort()).toEqual(['tdd-a', 'tdd-v', 'x-a', 'x-b']);
  });

  it('moving a source queues one reorder plus a rebuild, shows the new order at once, and a second move replaces the first', async () => {
    store.catalog.set(clashCatalog());
    store.moveSource(store.sourceById('b')!, -1);
    expect(store.tray().map(i => i.change.kind)).toEqual(['library.order', 'library.rebuild']);
    expect(store.tray()[0].change.args).toEqual({ order: ['vault', 'beta', 'alpha'] });
    expect(store.orderedSources().map(s => s.key)).toEqual(['vault', 'beta', 'alpha']);
    store.moveSource(store.sourceById('b')!, -1);
    expect(store.tray().filter(i => i.change.kind === 'library.order').length).toBe(1);
    expect(store.pendingOrder()).toEqual(['beta', 'vault', 'alpha']);
    store.moveSource(store.sourceById('b')!, -1);   // already first: nothing changes
    expect(store.pendingOrder()).toEqual(['beta', 'vault', 'alpha']);
    for (let i = 0; i < 6; i++) { for (const req of http.match('/api/v1/changes/preview')) req.flush(ok('x')); await Promise.resolve(); await Promise.resolve(); }
  });

  it('a check queued with a wire runs after it and waits for it; on its own it does not wait', async () => {
    store.catalog.set(catalog);
    store.verify('p1', { id: 'claude' } as any);
    expect(store.tray().map(i => i.deferred)).toEqual([false]);
    store.wire('p1', ['claude']);
    expect(store.tray().map(i => i.change.kind)).toEqual(['project.wire', 'project.verify']);
    expect(store.tray().map(i => i.deferred)).toEqual([false, true]);
    expect(store.tray()[1].change.args).toEqual({ projectId: 'p1', target: 'claude' });
    for (let n = 0; n < 4; n++) { for (const req of http.match('/api/v1/changes/preview')) req.flush(ok('x')); await Promise.resolve(); await Promise.resolve(); }
  });

  it('fetching several sources queues one fetch each and a single rebuild; folders and the vault are left out', async () => {
    store.catalog.set(catalog);
    const git = (id: string, key: string) => ({ ...src(id, key), kind: 'git' as const });
    store.fetchMany([git('g1', 'one'), git('g2', 'two'), src('l', 'folder'), src('v', 'vault', 'primary')] as any);
    expect(store.tray().map(i => i.change)).toEqual([
      { kind: 'source.fetch', args: { name: 'one' } }, { kind: 'source.fetch', args: { name: 'two' } }, { kind: 'library.rebuild' },
    ]);
    store.fetchMany([git('g1', 'one')] as any);                // the same again adds nothing, not even a second rebuild
    expect(store.tray().length).toBe(3);
    store.fetchMany([src('l', 'folder')] as any);              // nothing fetchable: not even a rebuild is queued
    store.fetchMany([]);
    expect(store.tray().length).toBe(3);
    for (let n = 0; n < 6; n++) { for (const req of http.match('/api/v1/changes/preview')) req.flush(ok('x')); await Promise.resolve(); await Promise.resolve(); }
  });

  it('checking several agents queues one check each; the same check is never queued twice', async () => {
    store.catalog.set(catalog);
    store.verifyMany([{ projectId: 'p1', target: 'claude' }, { projectId: 'p1', target: 'codex' }, { projectId: 'p2', target: 'claude' }]);
    expect(store.tray().map(i => i.change)).toEqual([
      { kind: 'project.verify', args: { projectId: 'p1', target: 'claude' } },
      { kind: 'project.verify', args: { projectId: 'p1', target: 'codex' } },
      { kind: 'project.verify', args: { projectId: 'p2', target: 'claude' } },
    ]);
    store.verifyMany([{ projectId: 'p1', target: 'claude' }]);
    store.verifyMany([]);
    expect(store.tray().length).toBe(3);
    for (let n = 0; n < 8; n++) { for (const req of http.match('/api/v1/changes/preview')) req.flush(ok('x')); await Promise.resolve(); await Promise.resolve(); }
  });

  it('a comparison answer for an earlier request is ignored', async () => {
    store.catalog.set(clashCatalog());
    const first = store.compare('tdd-a', 'tdd-v');
    const second = store.compare('x-a', 'x-b');
    http.expectOne('/api/v1/skills/tdd-a/compare/tdd-v?generation=g1').flush({ identical: true });
    http.expectOne('/api/v1/skills/x-a/compare/x-b?generation=g1').flush({ identical: false });
    await first; await second;
    expect(store.comparison()?.identical).toBe(false);
    expect(store.compareBusy()).toBe(false);
  });

  describe('name clashes queue', () => {
    const brain = (over: Partial<Catalog['collisions'][number]> = {}) => ({ name: 'brainstorming', winnerId: 'b-v', candidateIds: ['b-v', 'b-a', 'b-b', 'b-c'], preferredSourceId: null, kind: 'default' as const, by: 'default' as const, stale: false, changedSourceIds: [], identicalIds: ['b-c'], resolved: false, keptNames: [], ...over });
    const keepCatalog = (over: Partial<Catalog['collisions'][number]> = {}): Catalog => {
      const base = clashCatalog();
      return {
        ...base,
        sources: [...base.sources, src('c', 'gamma')],
        sourceOrder: ['v', 'a', 'b', 'c'],
        skills: [...base.skills,
          { id: 'b-v', sourceId: 'v', name: 'brainstorming', relativePath: 'b', digest: 'd1' }, { id: 'b-a', sourceId: 'a', name: 'brainstorming', relativePath: 'b', digest: 'd2' },
          { id: 'b-b', sourceId: 'b', name: 'brainstorming', relativePath: 'b', digest: 'd2' }, { id: 'b-c', sourceId: 'c', name: 'brainstorming', relativePath: 'b', digest: 'd1' }],
        collisions: [...base.collisions.map(c => c.name === 'x' ? { ...c, resolved: true, kind: 'choice' as const } : c), brain(over)],
      };
    };

    it('queueRows leaves out identical clashes and puts unresolved before resolved', () => {
      store.catalog.set(keepCatalog());
      expect(store.queueRows().map(r => r.collision.name)).toEqual(['tdd', 'brainstorming', 'x']);
      expect(store.queueRows().map(r => r.planned)).toEqual([false, false, false]);
    });

    it('groups copies that differ from the main by content, naming the highest-ranked holder', () => {
      store.catalog.set(keepCatalog());
      const row = store.queueRows().find(r => r.collision.name === 'brainstorming')!;
      expect(row.main.id).toBe('b-v');
      expect(row.others.map(o => ({ skill: o.skill.id, also: o.also.map(a => a.id) }))).toEqual([{ skill: 'b-a', also: ['b-b'] }]);
    });

    it('keep queues the keep and then the rebuild, with the source keys as the server expects', () => {
      store.catalog.set(keepCatalog());
      const row = store.queueRows().find(r => r.collision.name === 'brainstorming')!;
      store.keep('brainstorming', store.vault()!, [{ source: store.sourceById('a')!, name: 'brainstorming-gate', description: 'Gate.' }]);
      expect(store.tray().map(i => i.change)).toEqual([
        { kind: 'library.keep', args: { skill: 'brainstorming', main: 'vault', keep: [{ source: 'alpha', name: 'brainstorming-gate', description: 'Gate.' }] } },
        { kind: 'library.rebuild' },
      ]);
      expect(store.queueRows().find(r => r.collision === row.collision || r.collision.name === 'brainstorming')!.planned).toBe(true);
      http.match('/api/v1/changes/preview');
    });

    it('nameProblem mirrors the server: pattern, prefix, length, and names in use or pending', () => {
      store.catalog.set(keepCatalog());
      expect(store.nameProblem('brainstorming', 'Brainstorming-X')).toMatch(/lower-case/);
      expect(store.nameProblem('brainstorming', 'other-name')).toMatch(/must start with "brainstorming-"/);
      expect(store.nameProblem('brainstorming', 'brainstorming-' + 'a'.repeat(60))).toMatch(/at most 64/);
      expect(store.nameProblem('tdd', 'tdd')).toMatch(/must start with|in use/);
      expect(store.nameProblem('brainstorming', 'brainstorming-gate')).toBeNull();
      store.keep('brainstorming', store.vault()!, [{ source: store.sourceById('a')!, name: 'brainstorming-gate', description: 'Gate.' }]);
      expect(store.nameProblem('brainstorming', 'brainstorming-gate')).toMatch(/already in use/);
      store.tray.set([]);
      store.catalog.update(c => ({ ...c!, skills: [...c!.skills, { id: 'k', sourceId: 'v', name: 'Brainstorming-Kept', relativePath: 'k' }] }));
      expect(store.nameProblem('brainstorming', 'brainstorming-kept')).toMatch(/already in use/);
      http.match('/api/v1/changes/preview');
    });

    /** brainstorming with alpha's copy already kept as brainstorming-gate, and a new copy that the rule does not cover. */
    const keptAgain = (): Catalog => {
      const c = keepCatalog({ keptNames: ['brainstorming-gate'] });
      return { ...c, skills: [...c.skills,
        { id: 'kept-gate', sourceId: 'a', name: 'brainstorming-gate', relativePath: 'b', kept: { fromSkill: 'brainstorming', fromSourceId: 'a', stale: false, built: true, description: 'The gated copy.' } }] };
    };

    it('nameProblem takes the lower-case form of an upper-case plain name as the prefix', () => {
      store.catalog.set(keepCatalog());
      expect(store.nameProblem('Brainstorming', 'brainstorming-x')).toBeNull();
      expect(store.nameProblem('Brainstorming', 'other-x')).toMatch(/must start with "brainstorming-"/);
    });

    it('nameProblem lets a clash keep its own kept names, and no other clash', () => {
      store.catalog.set(keptAgain());
      expect(store.nameProblem('brainstorming', 'brainstorming-gate', ['brainstorming-gate'])).toBeNull();
      expect(store.nameProblem('brainstorming', 'brainstorming-gate', ['Brainstorming-Gate'])).toBeNull();
      expect(store.nameProblem('brainstorming', 'brainstorming-gate')).toMatch(/already in use/);
    });

    it('a row for a clash that already has kept copies opens with their names and descriptions, ready to approve', async () => {
      store.catalog.set(keptAgain());
      const row = store.queueRows().find(r => r.collision.name === 'brainstorming')!;
      const fixture = TestBed.createComponent(ClashRow);
      fixture.componentRef.setInput('row', row);
      await fixture.whenStable();
      const host: HTMLElement = fixture.nativeElement;
      expect((host.querySelector('#keep-name-b-a') as HTMLInputElement).value).toBe('brainstorming-gate');
      expect((host.querySelector('#keep-desc-b-a') as HTMLTextAreaElement).value).toBe('The gated copy.');
      expect(host.querySelector('.field-error')).toBeNull();
      const approve = [...host.querySelectorAll('button')].find(b => b.textContent === 'Approve') as HTMLButtonElement;
      expect(approve.disabled).toBe(false);
    });

    it('descriptionProblem refuses empty, multi-line and over-long text', () => {
      expect(store.descriptionProblem('  ')).toMatch(/must not be empty/);
      expect(store.descriptionProblem('a\nb')).toMatch(/no line breaks/);
      expect(store.descriptionProblem('a'.repeat(901))).toMatch(/at most 900/);
      expect(store.descriptionProblem('fine')).toBeNull();
    });

    it('clashCounts counts a resolved clash as decided even when only the default order chose', () => {
      store.catalog.set(keepCatalog({ resolved: true, keptNames: ['brainstorming-gate'] }));
      expect(store.clashCounts()).toEqual({ identical: 1, decided: 2, needs: 0, changed: 1, total: 4 });
    });

    it('a clash row keeps Approve disabled until the name and description are valid, then queues the keep', async () => {
      store.catalog.set(keepCatalog());
      const row = store.queueRows().find(r => r.collision.name === 'brainstorming')!;
      const fixture = TestBed.createComponent(ClashRow);
      fixture.componentRef.setInput('row', row);
      await fixture.whenStable();
      const host: HTMLElement = fixture.nativeElement;
      const approve = () => [...host.querySelectorAll('button')].find(b => b.textContent === 'Approve') as HTMLButtonElement;
      const type = async (el: HTMLInputElement | HTMLTextAreaElement, value: string) => { el.value = value; el.dispatchEvent(new Event('input')); fixture.detectChanges(); await fixture.whenStable(); };
      expect(approve().disabled).toBe(true);
      await type(host.querySelector('#keep-name-b-a') as HTMLInputElement, 'Brainstorming-Gate');
      expect(host.querySelector('.field-error')?.textContent).toMatch(/lower-case/);
      await type(host.querySelector('#keep-name-b-a') as HTMLInputElement, 'brainstorming-gate');
      expect(approve().disabled).toBe(true);
      await type(host.querySelector('#keep-desc-b-a') as HTMLTextAreaElement, 'Adds a gate.');
      expect(approve().disabled).toBe(false);
      approve().click();
      expect(store.tray()[0].change.args).toEqual({ skill: 'brainstorming', main: 'vault', keep: [{ source: 'alpha', name: 'brainstorming-gate', description: 'Adds a gate.' }] });
      http.match('/api/v1/changes/preview');
    });

    describe('suggestions', () => {
      const URL = '/api/v1/suggest';
      const threeOpen = () => { const c = keepCatalog(); return { ...c, collisions: c.collisions.map(x => x.name === 'x' ? { ...x, resolved: false } : x) }; };
      const suggestion = (source: string, name: string, over: Record<string, string> = {}) => ({ source, name, description: `About ${name}.`, difference: `${name} differs`, by: 'claude', ...over });
      const busy = () => ({ error: { code: 'BUSY', message: 'Two suggestions are already running.', retryable: true } });
      afterEach(() => vi.useRealTimers());

      it('suggestAll never has more than two requests open, and progress counts clashes', async () => {
        store.catalog.set(threeOpen());
        const run = store.suggestAll();
        await settle();
        const open = http.match(URL);
        expect(open.map(r => r.request.body)).toEqual([{ skill: 'tdd', main: 'alpha' }, { skill: 'x', main: 'alpha' }]);
        expect(open[0].request.headers.get('X-Agentforge-Write')).toBe('1');
        expect(store.suggestProgress()).toEqual({ done: 0, total: 3 });
        open[0].flush({ suggestions: [suggestion('vault', 'tdd-gate')] });
        await settle();
        expect(store.suggestProgress()).toEqual({ done: 1, total: 3 });
        const third = http.match(URL);
        expect(third.map(r => r.request.body)).toEqual([{ skill: 'brainstorming', main: 'vault' }]);
        open[1].flush({ suggestions: [suggestion('beta', 'x-b')] });
        third[0].flush({ suggestions: [suggestion('alpha', 'brainstorming-gate')] });
        await run;
        expect(store.suggestProgress()).toEqual({ done: 3, total: 3 });
        expect([...store.suggestions().keys()].sort()).toEqual(['brainstorming', 'tdd', 'x']);
        http.expectNone(URL);
      });

      it('a row button waits for a free slot while suggestAll has two requests open', async () => {
        store.catalog.set(threeOpen());
        const run = store.suggestAll(['tdd', 'x']);
        await settle();
        const open = http.match(URL);
        expect(open.length).toBe(2);
        const single = store.suggestOne('brainstorming');
        await settle();
        expect(http.match(URL).length).toBe(0);
        open[0].flush({ suggestions: [suggestion('vault', 'tdd-gate')] });
        await settle();
        const third = http.match(URL);
        expect(third.map(r => r.request.body.skill)).toEqual(['brainstorming']);
        open[1].flush({ suggestions: [suggestion('beta', 'x-b')] });
        third[0].flush({ suggestions: [suggestion('alpha', 'brainstorming-gate')] });
        await run; await single;
        expect(store.suggestErrors().size).toBe(0);
      });

      it('suggestAll leaves out clashes that already have suggestions or are not in the names given', async () => {
        store.catalog.set(threeOpen());
        store.suggestions.set(new Map([['tdd', [suggestion('vault', 'tdd-gate') as any]]]));
        const run = store.suggestAll(['tdd', 'x']);
        await settle();
        const open = http.match(URL);
        expect(open.map(r => r.request.body.skill)).toEqual(['x']);
        open[0].flush({ suggestions: [suggestion('beta', 'x-b')] });
        await run;
        expect(store.suggestProgress()).toEqual({ done: 1, total: 1 });
      });

      it('retries a BUSY reply once after two seconds, and then gives up on that clash without stopping the run', async () => {
        vi.useFakeTimers();
        store.catalog.set(threeOpen());
        const run = store.suggestAll(['tdd', 'x']);
        await vi.advanceTimersByTimeAsync(0);
        const first = http.match(URL);
        expect(first.length).toBe(2);
        first[0].flush(busy(), { status: 503, statusText: 'Busy' });
        first[1].flush({ suggestions: [suggestion('beta', 'x-b')] });
        await vi.advanceTimersByTimeAsync(1999);
        http.expectNone(URL);
        await vi.advanceTimersByTimeAsync(1);
        const retry = http.match(URL);
        expect(retry.map(r => r.request.body.skill)).toEqual(['tdd']);
        retry[0].flush(busy(), { status: 503, statusText: 'Busy' });
        await run;
        expect(store.suggestions().has('x')).toBe(true);
        expect(store.suggestions().has('tdd')).toBe(false);
        expect(store.suggestErrors().get('tdd')).toMatch(/already running/);
        expect(store.suggestProgress()).toEqual({ done: 2, total: 2 });
        http.expectNone(URL);
      });

      it('a suggestion fills only fields the owner has not typed in, and Suggest again refills the rest', async () => {
        store.catalog.set(keepCatalog());
        const row = store.queueRows().find(r => r.collision.name === 'brainstorming')!;
        const fixture = TestBed.createComponent(ClashRow);
        fixture.componentRef.setInput('row', row);
        await fixture.whenStable();
        const host: HTMLElement = fixture.nativeElement;
        const input = (id: string) => host.querySelector(id) as HTMLInputElement & HTMLTextAreaElement;
        const type = async (el: HTMLInputElement | HTMLTextAreaElement, value: string) => { el.value = value; el.dispatchEvent(new Event('input')); fixture.detectChanges(); await fixture.whenStable(); };
        await type(input('#keep-name-b-a'), 'brainstorming-mine');
        const first = store.suggestOne('brainstorming');
        await settle();
        http.expectOne(URL).flush({ suggestions: [suggestion('alpha', 'brainstorming-claude', { difference: 'adds a gate' })] });
        await first; fixture.detectChanges(); await fixture.whenStable();
        expect(input('#keep-name-b-a').value).toBe('brainstorming-mine');
        expect(input('#keep-desc-b-a').value).toBe('About brainstorming-claude.');
        expect(host.textContent).toContain('Differs: adds a gate');
        expect(host.querySelector('.origin')?.textContent).toContain('typed by you');
        await type(input('#keep-desc-b-a'), 'Typed description.');
        const again = [...host.querySelectorAll('button')].find(b => b.textContent?.trim() === 'Suggest again') as HTMLButtonElement;
        again.click();
        await settle();
        const req = http.expectOne(URL);
        expect(req.request.body).toEqual({ skill: 'brainstorming', main: 'vault', fresh: true });
        req.flush({ suggestions: [suggestion('alpha', 'brainstorming-new', { by: 'fallback' })] });
        await settle(); fixture.detectChanges(); await fixture.whenStable();
        expect(input('#keep-name-b-a').value).toBe('brainstorming-mine');
        expect(input('#keep-desc-b-a').value).toBe('Typed description.');
      });

      it('the queue asks for confirmation before sending anything, then shows progress', async () => {
        store.catalog.set(threeOpen());
        const fixture = TestBed.createComponent(ClashQueue);
        await fixture.whenStable();
        const host: HTMLElement = fixture.nativeElement;
        const button = (label: string) => [...host.querySelectorAll('button')].find(b => b.textContent?.trim() === label) as HTMLButtonElement;
        const click = async (b: HTMLButtonElement) => { b.click(); fixture.detectChanges(); await fixture.whenStable(); };
        await click(button('Suggest names for 3'));
        expect(host.textContent).toContain('Sends one short question per clash to Claude on your account. Nothing changes until you approve and apply.');
        http.expectNone(URL);
        await click(button('Cancel'));
        expect(button('Suggest names for 3')).toBeTruthy();
        await click(button('Suggest names for 3'));
        await click(button('Suggest names'));
        await settle();
        const open = http.match(URL);
        expect(open.length).toBe(2);
        fixture.detectChanges();
        expect(host.textContent).toContain('0 of 3 clashes suggested');
        open[0].flush({ suggestions: [] }); open[1].flush({ suggestions: [] });
        await settle();
        for (const r of http.match(URL)) r.flush({ suggestions: [] });
        await settle();
        fixture.detectChanges();
        expect(host.textContent).toContain('3 of 3 clashes suggested');
      });

      it('an untouched row shows the suggestion and says who made it', async () => {
        store.catalog.set(keepCatalog());
        const row = store.queueRows().find(r => r.collision.name === 'brainstorming')!;
        const fixture = TestBed.createComponent(ClashRow);
        fixture.componentRef.setInput('row', row);
        await fixture.whenStable();
        const host: HTMLElement = fixture.nativeElement;
        const run = store.suggestOne('brainstorming');
        await settle();
        http.expectOne(URL).flush({ suggestions: [suggestion('alpha', 'brainstorming-fb', { by: 'fallback' })] });
        await run; fixture.detectChanges(); await fixture.whenStable();
        expect((host.querySelector('#keep-name-b-a') as HTMLInputElement).value).toBe('brainstorming-fb');
        expect(host.querySelector('.origin')?.textContent).toContain('fallback suggestion');
        const approve = [...host.querySelectorAll('button')].find(b => b.textContent === 'Approve') as HTMLButtonElement;
        expect(approve.disabled).toBe(false);
      });
    });

    it('copies the previewed digests into the queued keep, so Apply sends what the person saw', async () => {
      store.catalog.set(keepCatalog());
      store.keep('brainstorming', store.vault()!, [{ source: store.sourceById('a')!, name: 'brainstorming-gate', description: 'Gate.' }]);
      const keepArgs = { skill: 'brainstorming', main: 'vault', keep: [{ source: 'alpha', name: 'brainstorming-gate', description: 'Gate.' }] };
      http.expectOne('/api/v1/changes/preview').flush({ kind: 'library.keep', title: 'Keep', lines: [], conflicts: [], ok: true, args: { ...keepArgs, digests: { vault: 'd1', alpha: 'd2' } } });
      await settle();
      expect(store.tray()[0].change.args).toEqual({ ...keepArgs, digests: { vault: 'd1', alpha: 'd2' } });
      http.expectOne('/api/v1/changes/preview').flush(ok('Rebuild'));
      await settle();
      const apply = store.apply();
      const req = http.expectOne('/api/v1/changes/apply');
      expect(req.request.body.changes[0].args.digests).toEqual({ vault: 'd1', alpha: 'd2' });
      req.flush({ results: [result('library.keep', 'Keep', 'applied')] });
      await settle();
      http.expectOne('/api/v1/changes/apply').flush({ results: [result('library.rebuild', 'Rebuild', 'applied')] });
      await refreshAfter(apply);
    });
  });

  describe('kept copies that need a look', () => {
    const issue = (over: Partial<Catalog['keptIssues'][number]> = {}) => ({ name: 'tdd-lab', fromSkill: 'tdd', fromSourceId: 'v', kind: 'stale' as const, ...over });
    const withIssues = (keptIssues: Catalog['keptIssues'], collisions?: Catalog['collisions']): Catalog => { const base = clashCatalog(); return { ...base, keptIssues, collisions: collisions || base.collisions }; };
    const flushPreviews = async () => { for (let i = 0; i < 4; i++) { for (const req of http.match('/api/v1/changes/preview')) req.flush(ok('x')); await settle(); } };

    it('one changed original gives exactly one row: the stale-choice row is not shown beside its stale kept copy', () => {
      store.catalog.set(withIssues([issue()]));
      expect(store.attention().map(r => [r.name, r.kind, r.issue?.name ?? null])).toEqual([['tdd', 'stale', 'tdd-lab'], ['x', 'default', null]]);
    });

    it('a changed clash that stale kept copies do not explain still shows as a choice row', () => {
      store.catalog.set(withIssues([issue({ fromSourceId: 'b' })]));
      expect(store.attention().map(r => [r.name, r.kind])).toEqual([['tdd', 'changed'], ['tdd', 'stale'], ['x', 'default']]);
    });

    it('the library card draws one row per thing to look at, even when two share a clash name', async () => {
      store.catalog.set(withIssues([issue({ fromSourceId: 'b' })]));
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      try {
        const fixture = TestBed.createComponent(LibraryCard);
        await fixture.whenStable();
        // A fresh catalogue redraws the list over the rows already there, which is where row identity matters.
        store.catalog.set(withIssues([issue({ fromSourceId: 'b' })]));
        fixture.detectChanges(); await fixture.whenStable();
        const rows = [...(fixture.nativeElement as HTMLElement).querySelectorAll('.clash-row')];
        expect(rows.map(r => r.querySelector('strong')?.textContent)).toEqual(['tdd', 'tdd', 'x']);
        expect(warn.mock.calls.flat().join(' ')).not.toMatch(/NG0955/);
      } finally { warn.mockRestore(); }
    });

    it('a missing issue needs no clash; Remove queues the unkeep and a rebuild', async () => {
      store.catalog.set(withIssues([issue({ name: 'gone-copy', fromSkill: 'gone', fromSourceId: null, kind: 'missing' })], []));
      expect(store.attention().map(r => [r.name, r.kind])).toEqual([['gone', 'missing']]);
      store.unkeep(store.attention()[0].issue!.name);
      expect(store.tray().map(i => [i.change.kind, i.change.args])).toEqual([['library.unkeep', { name: 'gone-copy' }], ['library.rebuild', undefined]]);
      await flushPreviews();
    });

    it('taken and is-main issues offer Rename, which opens that clash focused in the Name clashes view', () => {
      store.catalog.set(withIssues([issue({ name: 'x-lab', fromSkill: 'x', fromSourceId: 'b', kind: 'taken' }), issue({ name: 'x-main', fromSkill: 'x', fromSourceId: 'a', kind: 'is-main' })]));
      expect(store.attention().map(r => [r.name, r.kind])).toEqual([['tdd', 'changed'], ['x', 'taken'], ['x', 'is-main'], ['x', 'default']]);
      store.view.set('attention');
      store.renameKept('x');
      expect(store.view()).toBe('collisions');
      expect(store.focusedClash()).toBe('x');
    });

    it('rekeep queues the re-pin with the description only when one is given, then a rebuild', async () => {
      store.catalog.set(withIssues([issue()]));
      store.rekeep('tdd-lab');
      store.rekeep('tdd-lab', 'Use for lab work.');
      expect(store.tray().map(i => [i.change.kind, i.change.args])).toEqual([
        ['library.rekeep', { name: 'tdd-lab' }], ['library.rekeep', { name: 'tdd-lab', description: 'Use for lab work.' }], ['library.rebuild', undefined]]);
      await flushPreviews();
    });

    it('a rekeep preview carries the original digest into the queued change', async () => {
      store.catalog.set(withIssues([issue()]));
      store.rekeep('tdd-lab');
      http.expectOne('/api/v1/changes/preview').flush({ kind: 'library.rekeep', title: 'Rekeep', lines: [], conflicts: [], ok: true, args: { name: 'tdd-lab', digest: 'd9' } });
      await settle();
      expect(store.tray()[0].change.args).toEqual({ name: 'tdd-lab', digest: 'd9' });
      await flushPreviews();
    });

    it('Rename does nothing when there is no clash to go to', () => {
      store.catalog.set(withIssues([issue({ kind: 'taken', fromSkill: 'gone' })], []));
      store.view.set('attention');
      store.renameKept('gone');
      expect(store.view()).toBe('attention');
      expect(store.focusedClash()).toBe('');
    });

    it('offers the right actions for each kind of issue', () => {
      const labels = (kind: Catalog['keptIssues'][number]['kind']) => {
        store.catalog.set(withIssues([issue({ kind })]));
        const fixture = TestBed.createComponent(KeptIssueRow);
        fixture.componentRef.setInput('issue', issue({ kind }));
        fixture.detectChanges();
        return [...(fixture.nativeElement as HTMLElement).querySelectorAll('.actions button')].map(b => b.textContent!.trim());
      };
      expect(labels('stale')).toEqual(['Suggest again', 'Keep the description', 'Remove the copy']);
      expect(labels('missing')).toEqual(['Remove the rule']);
      expect(labels('is-main')).toEqual(['Remove the rule']);
      expect(labels('taken')).toEqual(['Rename']);
    });
  });
});
