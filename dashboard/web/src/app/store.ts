import { Injectable, computed, inject, signal } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { firstValueFrom } from 'rxjs';
import type { Catalog, Context, SkillDocument, Change, ChangeKind, ChangePreview, ChangeResult, ApplyResponse, Source, TargetReport } from '../../../contracts';
export type { Catalog, Context, Skill, Source, ProjectReport, TargetReport, Change, ChangePreview, ChangeResult, Feeds } from '../../../contracts';

export const PAGE_SIZE = 50;
const API = '/api/v1';
const READ = { 'X-Agentforge-Read': '1' };
const WRITE = { ...READ, 'X-Agentforge-Write': '1', 'Content-Type': 'application/json' };
function message(error: any): string { return error?.error?.error?.message || 'The dashboard server is not responding. Check it is still running, then refresh.'; }

/** Pipeline order: sources change first, then the library, then projects. */
const STAGE: Record<ChangeKind, number> = {
  'source.attach': 0, 'source.detach': 0, 'library.prefer': 0, 'source.fetch': 1,
  'library.rebuild': 2, 'project.add': 3, 'project.forget': 3, 'project.wire': 4,
};

export interface TrayItem { uid: number; change: Change; preview: ChangePreview | null; error: string; deferred: boolean }

export const AGENTS: Record<string, string> = { claude: 'Claude Code', codex: 'Codex', generic: 'Cursor and others', gemini: 'Gemini CLI' };

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

  // Library page state
  skillQuery = signal('');
  sourceFilter = signal('');
  view = signal<'all' | 'merged' | 'collisions'>('all');
  page = signal(0);
  skillId = signal('');

  // Change tray
  tray = signal<TrayItem[]>([]);
  trayOpen = signal(false);
  applying = signal(false);
  results = signal<ChangeResult[] | null>(null);
  applyError = signal('');
  private uid = 0;
  private documentRequest = 0;

  reading = computed(() => this.busy() || this.documentBusy() || this.applying());
  readonly blocked = computed(() => this.tray().some(i => !this.itemReady(i)));
  readonly checking = computed(() => this.tray().some(i => !i.preview && !i.error));

  readonly vault = computed(() => this.catalog()?.sources.find(s => s.kind === 'primary') || null);
  readonly attached = computed(() => this.catalog()?.sources.filter(s => s.kind !== 'primary') || []);
  readonly selectedSkill = computed(() => this.catalog()?.skills.find(x => x.id === this.skillId()) || null);
  /** Skills per source that made it into the computed library. */
  readonly contribution = computed(() => {
    const c = this.catalog(); if (!c) return [] as { source: Source; count: number }[];
    const winners = new Set(c.winnerIds);
    return c.sources.map(source => ({ source, count: c.skills.filter(s => s.sourceId === source.id && winners.has(s.id)).length }))
      .filter(x => x.count > 0);
  });
  readonly libraryTotal = computed(() => this.catalog()?.winnerIds.length ?? 0);
  readonly filteredSkills = computed(() => {
    const c = this.catalog(); if (!c) return [];
    const q = this.skillQuery().toLowerCase().trim();
    const allowed = this.view() === 'merged' ? new Set(c.winnerIds) : this.view() === 'collisions' ? new Set(c.collisions.flatMap(x => x.candidateIds)) : null;
    return c.skills.filter(s => (!allowed || allowed.has(s.id)) && (!this.sourceFilter() || s.sourceId === this.sourceFilter()) &&
      (!q || `${s.name} ${s.relativePath} ${this.sourceName(s.sourceId)}`.toLowerCase().includes(q)));
  });
  readonly pages = computed(() => Math.max(1, Math.ceil(this.filteredSkills().length / PAGE_SIZE)));
  readonly visibleSkills = computed(() => this.filteredSkills().slice(this.page() * PAGE_SIZE, (this.page() + 1) * PAGE_SIZE));

  sourceName(id: string) { const s = this.catalog()?.sources.find(x => x.id === id); return s ? (s.kind === 'primary' ? 'Your vault' : s.name) : 'Unknown source'; }
  sourceById(id: string) { return this.catalog()?.sources.find(x => x.id === id) || null; }
  collision(id: string) { return this.catalog()?.collisions.find(c => c.candidateIds.includes(id)); }
  skillById(id: string) { return this.catalog()?.skills.find(x => x.id === id) || null; }

  private get<T>(path: string) { return firstValueFrom(this.http.get<T>(API + path, { headers: READ })); }
  private post<T>(path: string, body: unknown) { return firstValueFrom(this.http.post<T>(API + path, body, { headers: WRITE })); }

  async start() { if (!this.context()) await this.refresh(); }

  async refresh() {
    if (this.busy() || this.documentBusy()) return;
    this.busy.set(true); this.error.set(''); this.document.set(null); this.documentError.set(''); this.documentRequest++;
    try {
      this.context.set(await this.get<Context>('/context'));
      const next = await this.get<Catalog>('/catalog');
      this.catalog.set(next); this.stale.set(false);
      if (this.sourceFilter() && !next.sources.some(s => s.id === this.sourceFilter())) this.sourceFilter.set('');
      this.page.set(Math.min(this.page(), this.pages() - 1));
      if (!next.skills.some(s => s.id === this.skillId())) this.skillId.set('');
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

  // ─── change tray ───────────────────────────────────────────────────────────
  /** Queue changes in pipeline order. Identical changes and repeated rebuilds collapse into one. */
  queue(...changes: Change[]) {
    if (this.applying()) return;
    if (this.results()) { this.results.set(null); this.tray.set([]); }
    const items = [...this.tray()];
    for (const change of changes) {
      const key = JSON.stringify(change);
      if (items.some(i => JSON.stringify(i.change) === key)) continue;
      items.push({ uid: ++this.uid, change, preview: null, error: '', deferred: false });
    }
    items.sort((a, b) => STAGE[a.change.kind] - STAGE[b.change.kind] || a.uid - b.uid);
    this.tray.set(this.markDeferred(items));
    this.trayOpen.set(true);
    void this.previewPending();
  }

  remove(uid: number) {
    const rest = this.tray().filter(i => i.uid !== uid);
    this.tray.set(this.markDeferred(rest));
    if (!rest.length) this.trayOpen.set(false);
  }
  discard() { if (this.applying()) return; this.tray.set([]); this.results.set(null); this.applyError.set(''); this.trayOpen.set(false); }

  /** An item is checked "as of now"; mark those whose real effect depends on earlier, unapplied items. */
  private markDeferred(items: TrayItem[]) {
    return items.map((item, i) => {
      const before = items.slice(0, i);
      const deferred = item.change.kind === 'library.rebuild' ? before.length > 0
        : item.change.kind === 'project.wire' ? before.some(b => b.change.kind === 'library.rebuild')
        : item.change.kind === 'source.fetch' ? before.some(b => b.change.kind === 'source.attach')
        : false;
      return { ...item, deferred };
    });
  }

  itemReady(item: TrayItem) {
    if (item.error) return false;
    if (!item.preview) return false;
    if (item.preview.ok) return true;
    // Waiting on an earlier queued step (a library a rebuild will create, a source an attach will add) is not a block.
    return item.deferred && item.preview.conflicts.every(c => /library has not been built|No Git source called/i.test(c));
  }

  /** One preview at a time (the server runs one change job at a time); items queued meanwhile are picked up by the same loop. */
  private previewing = false;
  private async previewPending() {
    if (this.previewing) return;
    this.previewing = true;
    try {
      for (let item = this.nextUnchecked(); item; item = this.nextUnchecked()) {
        const uid = item.uid;
        try {
          const preview = await this.post<ChangePreview>('/changes/preview', { change: item.change });
          this.tray.update(list => list.map(i => i.uid === uid ? { ...i, preview } : i));
        } catch (e) {
          // An item removed while it was being checked is no longer in the list, so these updates are no-ops.
          this.tray.update(list => list.map(i => i.uid === uid ? { ...i, error: message(e) } : i));
        }
      }
    } finally { this.previewing = false; }
  }
  private nextUnchecked() { return this.tray().find(i => !i.preview && !i.error); }

  async apply() {
    if (this.applying() || this.blocked() || !this.tray().length) return;
    this.applying.set(true); this.applyError.set('');
    try {
      const res = await this.post<ApplyResponse>('/changes/apply', { changes: this.tray().map(i => i.change) });
      this.results.set(res.results);
    } catch (e) { this.applyError.set(message(e)); }
    finally { this.applying.set(false); }
    await this.refresh();
  }

  finish() { this.results.set(null); this.tray.set([]); this.trayOpen.set(false); this.applyError.set(''); }

  // ─── intents used by the board ─────────────────────────────────────────────
  attach(location: string, name: string, branch: string) {
    const git = /^(https?:\/\/|ssh:\/\/|git@[^/:]+:)/i.test(location);
    const args: Record<string, string> = { location };
    if (name) args['name'] = name;
    if (git && branch) args['branch'] = branch;
    const derived = name || location.replace(/[\\/]+$/, '').split(/[\\/:]/).pop()!.replace(/\.git$/i, '');
    this.queue({ kind: 'source.attach', args }, ...(git ? [{ kind: 'source.fetch' as const, args: { name: derived } }] : []), { kind: 'library.rebuild' });
  }
  detach(source: Source) { this.queue({ kind: 'source.detach', args: { name: source.key } }, { kind: 'library.rebuild' }); }
  fetch(source?: Source) { this.queue({ kind: 'source.fetch', args: source ? { name: source.key } : {} }, { kind: 'library.rebuild' }); }
  rebuild() { this.queue({ kind: 'library.rebuild' }); }
  prefer(skill: string, source: Source | null) {
    this.queue({ kind: 'library.prefer', args: source && source.kind !== 'primary' ? { skill, source: source.key } : source ? { skill, source: 'vault' } : { skill } }, { kind: 'library.rebuild' });
  }
  addProject(path: string) { this.queue({ kind: 'project.add', args: { path } }); }
  forgetProject(projectId: string) { this.queue({ kind: 'project.forget', args: { projectId } }); }
  wire(projectId: string, targets: string[], opts: { writeDocs?: boolean; link?: string; repoint?: boolean } = {}) {
    const needsLibrary = !this.catalog()?.library.built;
    const wire: Change = { kind: 'project.wire', args: { projectId, targets, writeDocs: opts.writeDocs ?? true, link: opts.link ?? 'auto', repoint: opts.repoint ?? false } };
    this.queue(...(needsLibrary ? [{ kind: 'library.rebuild' as const }] : []), wire);
  }
  repoint(projectId: string, target: TargetReport) { this.wire(projectId, [target.id], { writeDocs: false, repoint: true }); }

  /** Changes waiting in the tray that touch a given thing, for ghost cables and badges. */
  pendingFor(kind: ChangeKind, match: (args: Record<string, unknown>) => boolean) {
    return this.tray().filter(i => i.change.kind === kind && match(i.change.args || {}));
  }
}
