import type { ProjectReport } from './store';
import { groupRows, projectRow } from './project-status';

/** The wiring map draws cables for a handful of projects at a time. A whole fleet of them would be a tangle. */
export const MAP_PAGE = 10;

/**
 * none: nothing chosen, so nothing is drawn. missing: what was chosen is no longer in the list.
 * project: one project. group: one folder, MAP_PAGE projects at a time.
 */
export interface MapScope {
  kind: 'none' | 'project' | 'group' | 'missing';
  reports: ProjectReport[];
  title: string; folder: string;
  total: number; page: number; pages: number; first: number; last: number;
}

const EMPTY: MapScope = { kind: 'none', reports: [], title: '', folder: '', total: 0, page: 1, pages: 1, first: 0, last: 0 };

/** The address says what to draw. A project wins over a folder; a page outside the folder is brought back inside it. */
export function mapScope(projects: ProjectReport[], params: { project?: string | null; group?: string | null; page?: string | null }): MapScope {
  if (params.project) {
    const r = projects.find(p => p.project.id === params.project);
    return r ? { ...EMPTY, kind: 'project', reports: [r], title: r.project.name, total: 1, first: 1, last: 1 } : { ...EMPTY, kind: 'missing' };
  }
  if (params.group) {
    const g = groupRows(projects.map(projectRow)).find(x => x.key === params.group);
    if (!g) return { ...EMPTY, kind: 'missing' };
    const total = g.rows.length, pages = Math.max(1, Math.ceil(total / MAP_PAGE));
    const asked = Number.parseInt(params.page ?? '', 10);
    const page = Math.min(pages, Math.max(1, Number.isFinite(asked) ? asked : 1));
    const start = (page - 1) * MAP_PAGE;
    const shown = g.rows.slice(start, start + MAP_PAGE).map(r => r.report);
    return { kind: 'group', reports: shown, title: g.label, folder: g.folder, total, page, pages, first: start + 1, last: start + shown.length };
  }
  return EMPTY;
}
