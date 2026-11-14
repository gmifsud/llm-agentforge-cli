import { TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { provideHttpClientTesting, HttpTestingController } from '@angular/common/http/testing';
import { provideRouter } from '@angular/router';
import { Store, type Catalog } from './store';
import { adoptSummary, differenceText, setAsideNote } from './skill-actions';
import type { Adoptable, SetAsideItem, Shadow } from '../../../contracts';

const library = { path: 'lib', built: true, builtAt: '', invalid: false, size: 1, add: [], remove: [], change: [], inSync: true };
const catalog: Catalog = {
  generation: 'g1', startedAt: '', completedAt: '', status: 'complete', mergeAvailable: true, library, projects: [], health: null, sourceOrder: [], sourceOrderExplicit: false, sinceLastBuild: null, sets: [], setAside: [],
  sources: [], skills: [], winnerIds: [], collisions: [], rejected: [], warnings: [],
};
const ok = (kind: string) => ({ kind, title: kind, lines: [], conflicts: [], ok: true });

describe('set aside, restore and adopt: store intents', () => {
  let store: Store, http: HttpTestingController;
  beforeEach(() => { TestBed.configureTestingModule({ providers: [provideHttpClient(), provideHttpClientTesting(), provideRouter([])] }); store = TestBed.inject(Store); http = TestBed.inject(HttpTestingController); });
  afterEach(() => http.verify());
  const drain = async () => { for (let n = 0; n < 6; n++) { for (const req of http.match('/api/v1/changes/preview')) req.flush(ok('x')); await Promise.resolve(); await Promise.resolve(); } };

  it('each queues one change with the arguments the server expects, and the same one is never queued twice', async () => {
    store.catalog.set(catalog);
    store.setAside('claude', 'tdd'); store.setAside('claude', 'tdd');
    store.restoreSkill('claude', 'old');
    store.adopt('p1', 'claude');
    store.adopt('p1', { id: 'claude' } as any);
    expect(store.tray().map(i => [i.change.kind, i.change.args])).toEqual([
      ['skill.setaside', { tool: 'claude', name: 'tdd' }],
      ['skill.restore', { tool: 'claude', name: 'old' }],
      ['project.adopt', { projectId: 'p1', target: 'claude' }],
    ]);
    await drain();
  });

  it('they run after the library is rebuilt and before any check, and an adopt waits for a queued rebuild', async () => {
    store.catalog.set(catalog);
    store.verify('p1', { id: 'claude' } as any);
    store.adopt('p1', 'claude');
    store.setAside('claude', 'tdd');
    store.rebuild();
    expect(store.tray().map(i => i.change.kind)).toEqual(['library.rebuild', 'skill.setaside', 'project.adopt', 'project.verify']);
    expect(store.tray().map(i => i.deferred)).toEqual([false, false, true, true]);
    await drain();
  });

  it('an adopt that only waits for a rebuild to build the library is not blocked', () => {
    store.tray.set([
      { uid: 1, change: { kind: 'library.rebuild' }, preview: ok('library.rebuild') as any, error: '', deferred: false },
      { uid: 2, change: { kind: 'project.adopt' }, preview: { ...ok('project.adopt'), ok: false, conflicts: ['The library at C:\\lib has not been built yet. Rebuild it first.'] } as any, error: '', deferred: true },
    ]);
    expect(store.blocked()).toBe(false);
  });
});

const shadow = (over: Partial<Shadow> = {}): Shadow => ({ name: 'tdd', tool: 'claude', level: 'personal', path: 'P', skillId: 's', libraryPath: 'L', same: false,
  personalDescription: 'mine', libraryDescription: 'theirs', personalFiles: 3, libraryFiles: 2, ...over });

describe('how a hiding skill differs from the library one, in words', () => {
  it('says identical, different, or that it could not tell', () => {
    expect(differenceText(shadow({ same: true }))).toBe('The two are identical, so nothing changes in what the skill says.');
    expect(differenceText(shadow())).toBe("Different content: the descriptions differ; yours has 3 files and the library's has 2.");
    expect(differenceText(shadow({ personalDescription: 'x', libraryDescription: 'x', personalFiles: 1, libraryFiles: 1 }))).toBe('Different content: the instructions or files differ.');
    expect(differenceText(shadow({ personalFiles: 2, libraryDescription: 'x', personalDescription: 'y' }))).toBe('Different content: the descriptions differ.');
    expect(differenceText(shadow({ same: null }))).toBe('The two could not be compared.');
  });
});

describe('what adopting a folder keeps and adds, in words', () => {
  const a = (over: Partial<Adoptable> = {}): Adoptable => ({ own: ['mine'], shared: ['tdd'], incoming: 2, others: 1, ...over });
  it('names what stays yours first, then what is added', () => {
    expect(adoptSummary(a())).toBe('1 skill of your own stays as it is. 1 has the same name as a library skill; yours is kept. 2 library skills are added beside yours.');
    expect(adoptSummary(a({ own: ['a', 'b'], shared: [], incoming: 1 }))).toBe('2 skills of your own stay as they are. 1 library skill is added beside yours.');
    expect(adoptSummary(a({ own: [], shared: [], incoming: 0 }))).toBe('Nothing from the library is missing here.');
  });
});

describe('the note on a set-aside skill', () => {
  const item = (over: Partial<SetAsideItem> = {}): SetAsideItem => ({ tool: 'claude', name: 'tdd', at: '2026-11-14T10:00:00.000Z', from: 'F', heldAt: 'H', restorable: true, ...over });
  it('says when it can go back and when something is in the way', () => {
    expect(setAsideNote(item())).toBe('Held at H. Restore puts it back at F.');
    expect(setAsideNote(item({ restorable: false }))).toBe('Something is at F now. Move it aside before restoring.');
  });
});
