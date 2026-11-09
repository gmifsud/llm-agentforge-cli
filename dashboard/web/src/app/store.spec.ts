import { TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { provideHttpClientTesting, HttpTestingController } from '@angular/common/http/testing';
import { provideRouter } from '@angular/router';
import { Store, type Catalog } from './store';
import { Library } from './library';

const library = { path: 'lib', built: true, builtAt: '', invalid: false, size: 1, add: [], remove: [], change: [], inSync: true };
const catalog: Catalog = {
  generation: 'g1', startedAt: '', completedAt: '', status: 'complete', mergeAvailable: true, library, projects: [],
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

  it('apply sends every queued change in order, keeps results, then refreshes', async () => {
    store.tray.set([
      { uid: 1, change: { kind: 'source.attach', args: { location: 'D:\\x' } }, preview: ok('Attach') as any, error: '', deferred: false },
      { uid: 2, change: { kind: 'library.rebuild' }, preview: ok('Rebuild') as any, error: '', deferred: true },
    ]);
    const run = store.apply();
    const req = http.expectOne('/api/v1/changes/apply');
    expect(req.request.body).toEqual({ changes: [{ kind: 'source.attach', args: { location: 'D:\\x' } }, { kind: 'library.rebuild' }] });
    req.flush({ results: [{ kind: 'source.attach', title: 'Attach x', status: 'applied', lines: [], message: '' }, { kind: 'library.rebuild', title: 'Rebuild', status: 'applied', lines: [], message: '' }] });
    await Promise.resolve(); await Promise.resolve();
    http.expectOne('/api/v1/context').flush({ readOnly: false, projects: [], platform: 'win32' });
    await Promise.resolve();
    http.expectOne('/api/v1/catalog').flush(catalog);
    await run;
    expect(store.results()?.map(r => r.status)).toEqual(['applied', 'applied']);
    store.finish();
    expect(store.tray()).toEqual([]);
  });
});
