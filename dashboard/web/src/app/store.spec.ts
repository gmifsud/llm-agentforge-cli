import { TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { provideHttpClientTesting, HttpTestingController } from '@angular/common/http/testing';
import { provideRouter } from '@angular/router';
import { Store, type Catalog } from './store';
import { Skills } from './skills';

const catalog: Catalog = {
  generation: 'g1', startedAt: '', completedAt: '', status: 'complete', mergeAvailable: true,
  sources: [{ id: 'source', kind: 'primary', name: 'Primary vault', location: 'fixture', root: 'fixture', state: 'available', revision: null, count: 1, rejectionCount: 0, error: null }],
  skills: [{ id: 'skill', sourceId: 'source', name: 'test-skill', relativePath: 'test-skill' }],
  winnerIds: ['skill'], collisions: [], rejected: [], warnings: [],
};
describe('read-only client state', () => {
  let store: Store, http: HttpTestingController;
  beforeEach(() => { TestBed.configureTestingModule({ providers: [provideHttpClient(), provideHttpClientTesting(), provideRouter([])] }); store = TestBed.inject(Store); http = TestBed.inject(HttpTestingController); });
  afterEach(() => http.verify());
  it('refresh retains stale rows on failure and pauses document reads', async () => {
    store.catalog.set(catalog);
    const run = store.refresh();
    http.expectOne('/api/v1/context').flush({ readOnly: true, projects: [], platform: 'win32' });
    await Promise.resolve();
    const req = http.expectOne('/api/v1/catalog');
    expect(req.request.method).toBe('GET'); expect(req.request.headers.get('X-Agentforge-Read')).toBe('1');
    req.flush({ error: { message: 'Registry corrupt' } }, { status: 503, statusText: 'Unavailable' });
    await run;
    expect(store.catalog()).toBe(catalog); expect(store.stale()).toBe(true);
    await store.readDocument('skill'); http.expectNone('/api/v1/skills/skill/document?generation=g1');
  });
  it('successful refresh replaces the catalogue and clears stale state', async () => {
    store.stale.set(true); store.sourceFilter.set('removed-source'); const run = store.refresh();
    http.expectOne('/api/v1/context').flush({ readOnly: true, projects: [], platform: 'win32' });
    await Promise.resolve(); http.expectOne('/api/v1/catalog').flush(catalog); await run;
    expect(store.stale()).toBe(false); expect(store.sourceFilter()).toBe(''); expect(store.filteredSkills().length).toBe(1);
  });
  it('filter and paging are local and do not issue requests', () => {
    store.catalog.set({ ...catalog, skills: Array.from({ length: 1000 }, (_, i) => ({ id: `s${i}`, name: `skill-${i}`, sourceId: 'source', relativePath: `skill-${i}` })) });
    const start = performance.now(); store.skillQuery.set('skill-99');
    expect(store.filteredSkills().length).toBe(11);
    expect(performance.now() - start).toBeLessThan(100);
    store.skillQuery.set(''); store.page.set(1); expect(store.visibleSkills().length).toBe(50);
  });
  it('renders instruction HTML as inert text', async () => {
    store.catalog.set(catalog); store.selectSkill('skill');
    store.document.set({ id: 'skill', sourceId: 'source', relativePath: 'test-skill', readAt: new Date().toISOString(), text: '<script>bad()</script><img src="https://example.com/leak">' });
    const fixture = TestBed.createComponent(Skills); await fixture.whenStable();
    const host: HTMLElement = fixture.nativeElement;
    expect(host.querySelector('pre')?.textContent).toContain('<script>bad()</script>');
    expect(host.querySelector('pre script, pre img')).toBeNull();
  });
  it('does not attach a previous skill error to the next selection', async () => {
    store.catalog.set(catalog); store.selectSkill('skill');
    const reading = store.readDocument('skill');
    store.selectSkill('other-skill');
    http.expectOne('/api/v1/skills/skill/document?generation=g1').flush({ error: { message: 'Old file failed' } }, { status: 503, statusText: 'Unavailable' });
    await reading;
    expect(store.documentError()).toBe('');
    expect(store.documentBusy()).toBe(false);
  });
  it('does not accept a project result after the user chooses a different project', async () => {
    const reading = store.inspectProject('project-a');
    store.projectId.set('project-b');
    http.expectOne('/api/v1/projects/project-a').flush({ project: { id: 'project-a' } });
    await reading;
    expect(store.project()).toBeNull();
  });
  it('serializes document and project reads to match the one-worker adapter', async () => {
    store.catalog.set(catalog); store.selectSkill('skill');
    const reading = store.readDocument('skill');
    const projectReading = store.inspectProject('project-a');
    http.expectNone('/api/v1/projects/project-a');
    http.expectOne('/api/v1/skills/skill/document?generation=g1').flush({ id: 'skill' });
    await reading; await projectReading;
  });
});
