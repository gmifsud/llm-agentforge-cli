import { Injectable, computed, inject, signal } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { firstValueFrom } from 'rxjs';
import type { Catalog, Context, SkillDocument, Change, ChangeKind, ChangePreview, ChangeResult, ApplyResponse, Source, TargetReport, Skill, Collision, SkillComparison } from '../../../contracts';
export type { Catalog, Context, Skill, Source, ProjectReport, TargetReport, Change, ChangePreview, ChangeResult, Feeds, Collision, SkillComparison, DiffHunk, LintFinding } from '../../../contracts';

export const PAGE_SIZE = 50;
const API = '/api/v1';
const READ = { 'X-Agentforge-Read': '1' };
const WRITE = { ...READ, 'X-Agentforge-Write': '1', 'Content-Type': 'application/json' };
function message(error: any): string { return error?.error?.error?.message || 'The dashboard server is not responding. Check it is still running, then refresh.'; }

/** Pipeline order: sources change first, then the library, then projects. */
const STAGE: Record<ChangeKind, number> = {
  'source.attach': 0, 'source.detach': 0, 'library.prefer': 0, 'library.order': 0, 'source.fetch': 1,
  'library.rebuild': 2, 'project.add': 3, 'project.forget': 3, 'project.wire': 4, 'project.verify': 5,
};

export type SkillView = 'all' | 'merged' | 'collisions' | 'attention' | 'problems';
export interface TrayItem { uid: number; change: Change; preview: ChangePreview | null; error: string; deferred: boolean }

/** Names people know the tools by. `generic` is the shared .agents folder that Codex, Gemini, Cursor and Antigravity all read. */
export const AGENTS: Record<string, string> = { claude: 'Claude Code', codex: 'Codex', generic: 'Shared .agents folder', gemini: 'Gemini CLI', cursor: 'Cursor', antigravity: 'Antigravity' };

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
  view = signal<SkillView>('all');
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
    const v = this.view();
    const allowed = v === 'merged' ? new Set(c.winnerIds)
      : v === 'collisions' ? new Set(c.collisions.flatMap(x => x.candidateIds))
      : v === 'attention' ? new Set(this.attention().flatMap(x => x.candidateIds))
      : v === 'problems' ? new Set([...(c.health?.findings || []).filter(f => f.severity !== 'info').map(f => f.skillId), ...(c.health?.shadows || []).map(s => s.skillId || '')])
      : null;
    return c.skills.filter(s => (!allowed || allowed.has(s.id)) && (!this.sourceFilter() || s.sourceId === this.sourceFilter()) &&
      (!q || `${s.name} ${s.relativePath} ${this.sourceName(s.sourceId)}`.toLowerCase().includes(q)));
  });
  readonly pages = computed(() => Math.max(1, Math.ceil(this.filteredSkills().length / PAGE_SIZE)));
  readonly visibleSkills = computed(() => this.filteredSkills().slice(this.page() * PAGE_SIZE, (this.page() + 1) * PAGE_SIZE));

  // ─── same-name skills ──────────────────────────────────────────────────────
  /** Clashes a person should look at: a copy changed since they chose, or only the built-in order decided. Changed first. */
  readonly attention = computed(() => {
    const all = this.catalog()?.collisions || [];
    return [...all.filter(c => c.kind === 'changed'), ...all.filter(c => c.kind === 'default')];
  });
  readonly clashCounts = computed(() => {
    const all = this.catalog()?.collisions || [];
    const n = (k: string[]) => all.filter(c => k.includes(c.kind)).length;
    return { identical: n(['identical']), decided: n(['choice', 'order']), needs: n(['default']), changed: n(['changed']), total: all.length };
  });
  clashByName(name: string) { return this.catalog()?.collisions.find(c => c.name === name) || null; }
  /** Why a skill is or is not what your agents get. */
  reason(skill: Skill): string {
    const c = this.catalog(); if (!c) return '';
    if (!c.mergeAvailable) return 'Unknown';
    if (c.winnerIds.includes(skill.id)) return 'In the library';
    const col = this.collision(skill.id); if (!col) return 'Not in the library';
    if (col.identicalIds.includes(skill.id)) return 'Identical to the one in use';
    return col.by === 'choice' ? 'You chose another' : col.by === 'order' ? 'Lower in your source order' : 'Lower in the default order';
  }
  findingsFor(skillId: string) { return (this.catalog()?.health?.findings || []).filter(f => f.skillId === skillId); }
  shadowsFor(skillId: string) { return (this.catalog()?.health?.shadows || []).filter(s => s.skillId === skillId); }

  // ─── source order ──────────────────────────────────────────────────────────
  /** Sources highest priority first; a queued reorder is shown as if already applied, so the list answers "what will it be". */
  readonly pendingOrder = computed(() => this.tray().find(i => i.change.kind === 'library.order')?.change.args?.['order'] as string[] | undefined);
  readonly orderedSources = computed(() => {
    const c = this.catalog(); if (!c) return [] as Source[];
    const pending = this.pendingOrder();
    const byId = pending ? pending.map(k => c.sources.find(s => s.key === k)) : c.sourceOrder.map(id => c.sources.find(s => s.id === id));
    const listed = byId.filter((s): s is Source => !!s);
    return [...listed, ...c.sources.filter(s => !listed.includes(s))];
  });
  moveSource(source: Source, delta: -1 | 1) {
    const order = this.orderedSources().map(s => s.key);
    const i = order.indexOf(source.key), j = i + delta;
    if (i < 0 || j < 0 || j >= order.length) return;
    [order[i], order[j]] = [order[j], order[i]];
    // One reorder at a time in the review sheet: a second move replaces the first.
    this.tray.update(list => list.filter(item => item.change.kind !== 'library.order'));
    this.queue({ kind: 'library.order', args: { order } }, { kind: 'library.rebuild' });
  }

  // ─── comparing two copies ──────────────────────────────────────────────────
  comparison = signal<SkillComparison | null>(null);
  compareBusy = signal(false);
  compareError = signal('');
  private compareRequest = 0;
  async compare(aId: string, bId: string) {
    const c = this.catalog(); if (!c || this.stale()) return;
    const request = ++this.compareRequest;
    this.compareBusy.set(true); this.compareError.set(''); this.comparison.set(null);
    try {
      const res = await this.get<SkillComparison>(`/skills/${aId}/compare/${bId}?generation=${encodeURIComponent(c.generation)}`);
      if (request === this.compareRequest) this.comparison.set(res);
    } catch (e) { if (request === this.compareRequest) this.compareError.set(message(e)); }
    finally { if (request === this.compareRequest) this.compareBusy.set(false); }
  }

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
        : item.change.kind === 'project.verify' ? before.some(b => ['project.wire', 'library.rebuild'].includes(b.change.kind))
        : false;
      return { ...item, deferred };
    });
  }

  itemReady(item: TrayItem) {
    if (item.error) return false;
    if (!item.preview) return false;
    if (item.preview.ok) return true;
    // Waiting on an earlier queued step (a library a rebuild will create, a source an attach will add) is not a block.
    return item.deferred && item.preview.conflicts.every(c => /library has not been built|No Git source called|does not exist yet\. Wire the agent first/i.test(c));
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
  /** Swap a link for a copy (a tool that ignores links), or refresh a copy that has fallen behind the library. */
  /** Ask the tool itself. A check queued behind a wire or rebuild runs after it, against the result. */
  verify(projectId: string, target: TargetReport) { this.queue({ kind: 'project.verify', args: { projectId, target: target.id } }); }
  copyFor(projectId: string, target: TargetReport) { this.wire(projectId, [target.id], { writeDocs: false, link: 'copy' }); }

  /** Changes waiting in the tray that touch a given thing, for ghost cables and badges. */
  pendingFor(kind: ChangeKind, match: (args: Record<string, unknown>) => boolean) {
    return this.tray().filter(i => i.change.kind === kind && match(i.change.args || {}));
  }
}
