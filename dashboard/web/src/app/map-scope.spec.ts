import { describe, expect, it } from 'vitest';
import { MAP_PAGE, mapScope } from './map-scope';
import type { ProjectReport } from './store';

const report = (path: string): ProjectReport => ({
  project: { id: `id:${path}`, name: path.split(/[\\/]/).pop()!, path, origin: 'saved', local: true }, readAt: '', deployment: { root: '', origin: '', warnings: [] },
  targets: [], state: 'available', warnings: [],
});
const folder = (name: string, n: number) => Array.from({ length: n }, (_, i) => report(`D:\\Repos\\${name}\\p${String(i).padStart(2, '0')}`));
const key = 'd:/repos/llm';

describe('the wiring map is drawn for one project or one folder, never the whole fleet', () => {
  const all = [...folder('LLM', 25), ...folder('Work', 3)];

  it('draws nothing without a scope', () => {
    const s = mapScope(all, {});
    expect(s.kind).toBe('none'); expect(s.reports).toEqual([]);
    expect(mapScope(all, { project: '', group: '' }).kind).toBe('none');
  });

  it('shows one project', () => {
    const s = mapScope(all, { project: 'id:D:\\Repos\\Work\\p01' });
    expect(s.kind).toBe('project'); expect(s.reports.map(r => r.project.name)).toEqual(['p01']); expect(s.title).toBe('p01');
  });

  it('says so when the project or folder is no longer there, instead of drawing something else', () => {
    expect(mapScope(all, { project: 'gone' }).kind).toBe('missing');
    expect(mapScope(all, { group: 'd:/nowhere' }).kind).toBe('missing');
    expect(mapScope(all, { project: 'gone' }).reports).toEqual([]);
  });

  it('shows a folder ten projects at a time, in name order', () => {
    expect(MAP_PAGE).toBe(10);
    const first = mapScope(all, { group: key });
    expect(first.kind).toBe('group');
    expect([first.total, first.pages, first.page, first.first, first.last]).toEqual([25, 3, 1, 1, 10]);
    expect(first.reports.map(r => r.project.name)).toEqual(Array.from({ length: 10 }, (_, i) => `p${String(i).padStart(2, '0')}`));
    expect(first.title).toBe('Repos\\LLM');
    expect(first.folder).toBe('D:\\Repos\\LLM');
    const last = mapScope(all, { group: key, page: '3' });
    expect([last.reports.length, last.first, last.last]).toEqual([5, 21, 25]);
  });

  it('keeps the page inside the folder, whatever the address says', () => {
    expect(mapScope(all, { group: key, page: '99' }).page).toBe(3);
    expect(mapScope(all, { group: key, page: '0' }).page).toBe(1);
    expect(mapScope(all, { group: key, page: '-4' }).page).toBe(1);
    expect(mapScope(all, { group: key, page: 'abc' }).page).toBe(1);
    expect(mapScope(all, { group: 'd:/repos/work', page: '2' }).page).toBe(1);   // three projects: one page
  });

  it('a project wins over a folder when both are given', () => {
    expect(mapScope(all, { project: 'id:D:\\Repos\\Work\\p00', group: key }).kind).toBe('project');
  });
});
