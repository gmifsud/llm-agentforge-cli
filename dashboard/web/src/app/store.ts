import { Injectable, computed, inject, signal } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { firstValueFrom } from 'rxjs';
import type { Catalog, Context, SkillDocument, ProjectReport } from '../../../contracts';
export type { Catalog, Context, Skill, Source, ProjectReport } from '../../../contracts';

export const PAGE_SIZE = 50;
const API = '/api/v1';
const HEADERS = { 'X-Agentforge-Read': '1' };
function message(error: any): string { return error?.error?.error?.message || 'The local adapter is unavailable. Check it is running, then retry.'; }

@Injectable({ providedIn: 'root' })
export class Store {
  private http = inject(HttpClient);
  context = signal<Context | null>(null);
  catalog = signal<Catalog | null>(null);
  busy = signal(false);
  stale = signal(false);
  error = signal('');
  document = signal<SkillDocument | null>(null);
  documentBusy = signal(false);
  documentError = signal('');
  project = signal<ProjectReport | null>(null);
  projectBusy = signal(false);
  projectError = signal('');
  reading = computed(() => this.busy() || this.documentBusy() || this.projectBusy());
  sourceQuery = signal('');
  skillQuery = signal('');
  sourceFilter = signal('');
  view = signal<'all' | 'merged' | 'collisions'>('all');
  page = signal(0);
  sourceId = signal('');
  skillId = signal('');
  projectId = signal('');
  private documentRequest = 0;
  private projectRequest = 0;
  readonly selectedSource = computed(() => this.catalog()?.sources.find(x => x.id === this.sourceId()) || null);
  readonly selectedSkill = computed(() => this.catalog()?.skills.find(x => x.id === this.skillId()) || null);
  readonly filteredSkills = computed(() => {
    const c = this.catalog(); if (!c) return [];
    const q = this.skillQuery().toLowerCase().trim();
    const allowed = this.view() === 'merged' ? new Set(c.winnerIds) : this.view() === 'collisions' ? new Set(c.collisions.flatMap(x => x.candidateIds)) : null;
    return c.skills.filter(s => (!allowed || allowed.has(s.id)) && (!this.sourceFilter() || s.sourceId === this.sourceFilter()) &&
      (!q || `${s.name} ${s.relativePath} ${this.sourceName(s.sourceId)}`.toLowerCase().includes(q)));
  });
  readonly pages = computed(() => Math.max(1, Math.ceil(this.filteredSkills().length / PAGE_SIZE)));
  readonly visibleSkills = computed(() => this.filteredSkills().slice(this.page() * PAGE_SIZE, (this.page() + 1) * PAGE_SIZE));
  sourceName(id: string) { return this.catalog()?.sources.find(s => s.id === id)?.name || 'Unknown source'; }
  collision(id: string) { return this.catalog()?.collisions.find(c => c.candidateIds.includes(id)); }
  private get<T>(path: string) { return firstValueFrom(this.http.get<T>(API + path, { headers: HEADERS })); }
  async start() { if (!this.context()) await this.refresh(); }
  async refresh() {
    if (this.reading()) return;
    this.busy.set(true); this.error.set(''); this.document.set(null); this.documentError.set(''); this.documentRequest++;
    try {
      this.context.set(await this.get<Context>('/context'));
      const next = await this.get<Catalog>('/catalog');
      this.catalog.set(next); this.stale.set(false);
      if (this.sourceFilter() && !next.sources.some(s => s.id === this.sourceFilter())) this.sourceFilter.set('');
      this.page.set(Math.min(this.page(), this.pages() - 1));
      if (!next.skills.some(s => s.id === this.skillId())) this.skillId.set('');
      if (!next.sources.some(s => s.id === this.sourceId())) this.sourceId.set('');
    } catch (e) { this.stale.set(true); this.error.set(message(e)); }
    finally { this.busy.set(false); }
  }
  async readDocument(id: string) {
    const c = this.catalog(); if (!c || this.stale() || this.reading()) return;
    const request = ++this.documentRequest;
    this.documentBusy.set(true); this.document.set(null); this.documentError.set('');
    try {
      const doc = await this.get<SkillDocument>(`/skills/${id}/document?generation=${encodeURIComponent(c.generation)}`);
      if (request === this.documentRequest && id === this.skillId() && c.generation === this.catalog()?.generation) this.document.set(doc);
    } catch (e) { if (request === this.documentRequest && id === this.skillId()) this.documentError.set(message(e)); }
    finally { if (request === this.documentRequest) this.documentBusy.set(false); }
  }
  selectSkill(id: string) { this.skillId.set(id); this.document.set(null); this.documentError.set(''); }
  selectProject(id: string) { this.projectId.set(id); this.project.set(null); this.projectError.set(''); }
  async inspectProject(id: string) {
    if (this.reading()) return;
    const request = ++this.projectRequest; this.projectId.set(id); this.projectBusy.set(true); this.project.set(null); this.projectError.set('');
    try { const p = await this.get<ProjectReport>(`/projects/${id}`); if (request === this.projectRequest && id === this.projectId()) this.project.set(p); }
    catch (e) { if (request === this.projectRequest && id === this.projectId()) this.projectError.set(message(e)); }
    finally { if (request === this.projectRequest) this.projectBusy.set(false); }
  }
}
