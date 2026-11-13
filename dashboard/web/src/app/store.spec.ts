import { TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { provideHttpClientTesting, HttpTestingController } from '@angular/common/http/testing';
import { provideRouter } from '@angular/router';
import { Store, type Catalog } from './store';
import { Library } from './library';

const library = { path: 'lib', built: true, builtAt: '', invalid: false, size: 1, add: [], remove: [], change: [], inSync: true };
const catalog: Catalog = {
  generation: 'g1', startedAt: '', completedAt: '', status: 'complete', mergeAvailable: true, library, projects: [], health: null, sourceOrder: ['source'], sourceOrderExplicit: false,
  sources: [{ id: 'source', key: 'vault', kind: 'primary', name: 'Primary vault', location: 'fixture', root: 'fixture', state: 'available', revision: null, count: 1, rejectionCount: 0, error: null }],
  skills: [{ id: 'skill', sourceId: 'source', name: 'test-skill', relativePath: 'test-skill' }],
  winnerIds: ['skill'], collisions: [], rejected: [], warnings: [],
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
    const first = http.expectOne('/api/v1/changes/apply');
    expect(first.request.body).toEqual({ changes: [{ kind: 'source.attach', args: { location: 'D:\\x' } }] });
    first.flush({ results: [result('source.attach', 'Attach x', 'applied')] });
    await settle();
    expect(store.applyProgress()).toEqual({ done: 1, total: 2 });
    const second = http.expectOne('/api/v1/changes/apply');
    expect(second.request.body).toEqual({ changes: [{ kind: 'library.rebuild' }] });
    second.flush({ results: [result('library.rebuild', 'Rebuild', 'applied')] });
    await refreshAfter(run);
    expect(store.results()?.map(r => r.status)).toEqual(['applied', 'applied']);
    expect(store.applyProgress()).toBeNull();
    store.finish();
    expect(store.tray()).toEqual([]);
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

  it('if the server stops answering part way, what ran is kept and the rest is marked not run', async () => {
    tray(['project.verify', { projectId: 'p1', target: 'claude' }], ['project.verify', { projectId: 'p2', target: 'claude' }], ['project.verify', { projectId: 'p3', target: 'claude' }]);
    const run = store.apply();
    http.expectOne('/api/v1/changes/apply').flush({ results: [result('project.verify', 'Check Claude Code in p1', 'applied')] });
    await settle();
    http.expectOne('/api/v1/changes/apply').flush({ error: { message: 'down' } }, { status: 503, statusText: 'Unavailable' });
    await refreshAfter(run);
    expect(store.results()?.map(r => r.status)).toEqual(['applied', 'skipped', 'skipped']);
    expect(store.results()?.[1].message).toMatch(/stopped answering/);
    expect(store.applyError()).not.toBe('');
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
      { name: 'tdd', winnerId: 'tdd-a', candidateIds: ['tdd-v', 'tdd-a'], preferredSourceId: 'a', kind: 'changed', by: 'choice', stale: true, changedSourceIds: ['v'], identicalIds: [] },
      { name: 'x', winnerId: 'x-a', candidateIds: ['x-a', 'x-b'], preferredSourceId: null, kind: 'default', by: 'default', stale: false, changedSourceIds: [], identicalIds: [] },
      { name: 'same', winnerId: 'same-v', candidateIds: ['same-v', 'same-b'], preferredSourceId: null, kind: 'identical', by: 'default', stale: false, changedSourceIds: [], identicalIds: ['same-b'] },
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
});
