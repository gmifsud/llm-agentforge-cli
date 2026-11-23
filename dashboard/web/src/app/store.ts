import { Injectable, computed, inject, signal } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { firstValueFrom } from 'rxjs';
import { savedChangesPreference, saveChangesPreference } from './changes-presentation';
import type { Catalog, Context, SetRule, SkillDocument, Change, ChangeKind, ChangePreview, ChangeResult, ApplyResponse, Source, Suggestion, SuggestResponse, TargetReport, Skill, Collision, KeptIssue, SkillComparison } from '../../../contracts';
export type { Catalog, Context, Skill, KeptIssue, SetRule, SetInfo, Shadow, SetAsideItem, Adoptable, Source, ProjectReport, TargetReport, Change, ChangePreview, ChangeResult, Feeds, Collision, SkillComparison, Suggestion, DiffHunk, LintFinding } from '../../../contracts';

export const PAGE_SIZE = 50;
const API = '/api/v1';
const READ = { 'X-Agentforge-Read': '1' };
const WRITE = { ...READ, 'X-Agentforge-Write': '1', 'Content-Type': 'application/json' };
function message(error: any): string { return error?.error?.error?.message || 'The dashboard server is not responding. Check it is still running, then refresh.'; }

/** Pipeline order: sources change first, then the library, then projects. */
const STAGE: Record<ChangeKind, number> = {
  'source.attach': 0, 'source.detach': 0, 'library.prefer': 0, 'library.keep': 0, 'library.unkeep': 0, 'library.rekeep': 0, 'library.order': 0, 'source.fetch': 1,
  'library.rebuild': 2, 'set.save': 2, 'set.remove': 3, 'project.add': 3, 'project.forget': 3, 'skill.setaside': 3, 'skill.restore': 3, 'project.wire': 4, 'project.adopt': 4, 'project.verify': 5,
};

/** Steps that stand alone, as on the server: a fetch or a check that cannot be made does not cancel the others. */
const INDEPENDENT = new Set<ChangeKind>(['source.fetch', 'project.verify']);

/** One clash to settle: the copy that keeps the name, and a name for each distinct other copy (`also`: copies identical to it). */
export interface QueueRow { collision: Collision; main: Skill; others: { skill: Skill; also: Skill[] }[]; planned: boolean }

const KEPT_NAME_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const KEPT_NAME_MAX = 64;
const KEPT_DESCRIPTION_MAX = 900;
/** The server runs two suggestions at a time; asking for more only earns a BUSY reply. */
const SUGGEST_CONCURRENCY = 2;
const SUGGEST_BUSY_RETRY_MS = 2000;

/**
 * One thing in Need a look. `choice` rows ('changed', 'default') are clashes; the rest come from a kept copy's issue, with the clash it
 * belongs to (null once the original is gone). `name` is always the clash's name.
 */
export interface AttentionRow { key: string; name: string; kind: 'changed' | 'default' | KeptIssue['kind']; collision: Collision | null; issue: KeptIssue | null; candidateIds: string[] }

export type SkillView = 'all' | 'merged' | 'collisions' | 'attention' | 'problems';
export interface TrayItem { uid: number; change: Change; preview: ChangePreview | null; error: string; deferred: boolean }
export interface RunStep { item: TrayItem; startedAt: number | null; result: ChangeResult | null }

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
  trayHidden = signal(savedChangesPreference() === 'hidden');
  readonly hasChanges = computed(() => this.tray().length > 0 || this.results() !== null);
  readonly changesLocked = computed(() => this.applying() || this.results() !== null);
  /** Execution state is separate from the final result sheet and its acknowledgement guard. */
  runSteps = signal<RunStep[]>([]);
  activeStep = signal<number | null>(null);
  applying = signal(false);
  /** While applying: how many steps have finished, out of how many. */
  applyProgress = signal<{ done: number; total: number } | null>(null);
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
  /**
   * What a person should look at: clashes whose choice has changed or that only the default order decided, and one row for each
   * kept copy with an issue. A changed clash that stale kept copies fully explain is left out, so one changed original gives one row.
   */
  readonly attention = computed<AttentionRow[]>(() => {
    const c = this.catalog(); if (!c) return [];
    const issues = c.keptIssues || [];
    const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
    const explained = (col: Collision) => col.changedSourceIds.length > 0 &&
      col.changedSourceIds.every(id => issues.some(i => i.kind === 'stale' && same(i.fromSkill, col.name) && i.fromSourceId === id));
    const open = c.collisions.filter(col => !col.resolved);
    const row = (col: Collision): AttentionRow => ({ key: `clash:${col.name}`, name: col.name, kind: col.kind === 'changed' ? 'changed' : 'default', collision: col, issue: null, candidateIds: col.candidateIds });
    const issueRows = issues.map((issue): AttentionRow => {
      const col = c.collisions.find(x => same(x.name, issue.fromSkill)) || null;
      return { key: `kept:${issue.name}`, name: col?.name ?? issue.fromSkill, kind: issue.kind, collision: col, issue, candidateIds: col?.candidateIds ?? [] };
    });
    return [...open.filter(col => col.kind === 'changed' && !explained(col)).map(row), ...issueRows, ...open.filter(col => col.kind === 'default').map(row)];
  });
  /** Which clash the Name clashes view should scroll to and focus: set by Rename on a kept copy that cannot take effect. */
  focusedClash = signal('');
  /** Go to the clash that needs another name for a kept copy. */
  renameKept(clash: string) {
    if (!this.catalog()?.collisions.some(c => c.name === clash)) return;
    this.view.set('collisions'); this.page.set(0); this.focusedClash.set(clash);
  }
  readonly clashCounts = computed(() => {
    const all = this.catalog()?.collisions || [];
    // A clash whose differing copies are all kept is decided, whatever chose its main copy.
    const open = all.filter(c => !c.resolved || c.kind === 'identical');
    const n = (k: string[]) => open.filter(c => k.includes(c.kind)).length;
    return { identical: n(['identical']), decided: all.filter(c => c.kind !== 'identical' && (c.resolved || ['choice', 'order'].includes(c.kind))).length, needs: n(['default']), changed: n(['changed']), total: all.length };
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

  // ─── the name clashes queue ────────────────────────────────────────────────
  /** Clashes with something to decide, unresolved first. Copies identical to each other need nothing. */
  readonly queueRows = computed<QueueRow[]>(() => {
    const c = this.catalog(); if (!c) return [];
    const rows = c.collisions.filter(col => col.kind !== 'identical').flatMap(collision => {
      const main = this.skillById(collision.winnerId);
      return main ? [{ collision, main, others: this.othersFor(collision, main), planned: this.keepPlanned(collision.name) }] : [];
    });
    return [...rows.filter(r => !r.collision.resolved), ...rows.filter(r => r.collision.resolved)];
  });
  /** Copies that differ from `main`, one entry per distinct content, naming the holder highest in the source order. */
  othersFor(collision: Collision, main: Skill): { skill: Skill; also: Skill[] }[] {
    const c = this.catalog(); if (!c) return [];
    const rank = (s: Skill) => { const i = c.sourceOrder.indexOf(s.sourceId); return i < 0 ? Number.MAX_SAFE_INTEGER : i; };
    const candidates = collision.candidateIds.map(id => this.skillById(id)).filter((x): x is Skill => !!x && x.id !== main.id)
      .filter(x => x.digest == null || x.digest !== main.digest).sort((a, b) => rank(a) - rank(b));
    const out: { skill: Skill; also: Skill[] }[] = [];
    const byDigest = new Map<string, { skill: Skill; also: Skill[] }>();
    for (const skill of candidates) {
      const held = skill.digest ? byDigest.get(skill.digest) : undefined;
      if (held) { held.also.push(skill); continue; }
      const entry = { skill, also: [] as Skill[] };
      out.push(entry);
      if (skill.digest) byDigest.set(skill.digest, entry);
    }
    return out;
  }
  keepPlanned(name: string) { return this.pendingFor('library.keep', a => a['skill'] === name).length > 0; }
  /**
   * Why `name` cannot be a kept copy of `plain`, or null. Mirrors the server's check; names compare in lower case here.
   * `own` are the clash's kept names now: saving the clash again may reuse them, as the server allows.
   */
  nameProblem(plain: string, name: string, own: readonly string[] = []): string | null {
    if (!KEPT_NAME_PATTERN.test(name)) return 'use lower-case letters, digits and single hyphens only';
    if (name.length > KEPT_NAME_MAX) return `at most ${KEPT_NAME_MAX} characters`;
    const prefix = `${plain.toLowerCase()}-`;
    if (!name.startsWith(prefix)) return `must start with "${prefix}"`;
    const taken = new Set<string>((this.catalog()?.skills || []).map(s => s.name.toLowerCase()));
    for (const item of this.pendingFor('library.keep', () => true)) {
      for (const k of (item.change.args?.['keep'] as { name: string }[] | undefined) || []) taken.add(k.name.toLowerCase());
    }
    for (const k of own) taken.delete(k.toLowerCase());
    return taken.has(name.toLowerCase()) ? 'that name is already in use' : null;
  }
  /** The kept copy made from `clash`'s copy in `sourceId`, if there is one. */
  keptFor(clash: string, sourceId: string): Skill | null {
    return (this.catalog()?.skills || []).find(s => !!s.kept && s.kept.fromSkill.toLowerCase() === clash.toLowerCase() && s.kept.fromSourceId === sourceId) || null;
  }
  descriptionProblem(description: string): string | null {
    if (description.trim() === '') return 'must not be empty';
    if (/[\r\n]/.test(description)) return 'must be a single paragraph with no line breaks';
    if (description.length > KEPT_DESCRIPTION_MAX) return `at most ${KEPT_DESCRIPTION_MAX} characters`;
    return null;
  }

  // ─── suggested names ───────────────────────────────────────────────────────
  /** Claude's (or the fallback's) suggestions per clash name. The queue fills untouched fields from these; nothing here changes the library. */
  suggestions = signal<Map<string, Suggestion[]>>(new Map());
  /** While suggestAll runs, and left in place afterwards: clashes handled (suggested or failed) out of those it set out to do. */
  suggestProgress = signal<{ done: number; total: number } | null>(null);
  /** Clashes asked about right now, by name. */
  suggesting = signal<ReadonlySet<string>>(new Set());
  /** Why a clash could not be suggested, by name. */
  suggestErrors = signal<Map<string, string>>(new Map());
  /** True while suggestAll is working through its list. */
  suggestRunning = signal(false);
  private slotsInUse = 0;
  private slotWaiters: (() => void)[] = [];
  /** The server runs two suggestions at once; every request, from suggestAll or a row button, waits here for one of two slots. */
  private async withSlot<T>(run: () => Promise<T>): Promise<T> {
    if (this.slotsInUse >= SUGGEST_CONCURRENCY) await new Promise<void>(resolve => this.slotWaiters.push(resolve));
    else this.slotsInUse++;
    try { return await run(); }
    finally { const next = this.slotWaiters.shift(); if (next) next(); else this.slotsInUse--; }
  }
  private sleep(ms: number) { return new Promise<void>(resolve => setTimeout(resolve, ms)); }

  /** Clashes that still need a decision and have nothing suggested yet, in queue order. `only` limits them to the names a page is showing. */
  suggestTargets(only?: readonly string[]): QueueRow[] {
    return this.queueRows().filter(r => !r.collision.resolved && !r.planned && r.others.length > 0 && !this.suggestions().has(r.collision.name) && (!only || only.includes(r.collision.name)));
  }

  /** One short question per clash, at most two at a time. A BUSY reply is tried once more after two seconds; any other failure is kept against that clash and the rest carry on. */
  async suggestAll(only?: readonly string[]): Promise<void> {
    if (this.suggestRunning()) return;
    const targets = this.suggestTargets(only).map(r => r.collision.name);
    if (!targets.length) return;
    this.suggestRunning.set(true);
    this.suggestProgress.set({ done: 0, total: targets.length });
    const queue = [...targets];
    const worker = async () => {
      for (let name = queue.shift(); name !== undefined; name = queue.shift()) {
        await this.suggestClash(name, false, undefined, true);
        this.suggestProgress.update(p => p && { ...p, done: p.done + 1 });
      }
    };
    try { await Promise.all(Array.from({ length: Math.min(SUGGEST_CONCURRENCY, targets.length) }, worker)); }
    finally { this.suggestRunning.set(false); }
  }

  /** Ask about one clash. `fresh` bypasses the server's cache; `main` is the copy keeping the plain name when the person has chosen another than the row's. */
  suggestOne(skill: string, fresh = false, main?: Source): Promise<void> { return this.suggestClash(skill, fresh, main, false); }
  private async suggestClash(skill: string, fresh: boolean, main: Source | undefined, retryBusy: boolean): Promise<void> {
    const row = this.queueRows().find(r => r.collision.name === skill);
    const mainSource = main || (row ? this.sourceById(row.main.sourceId) : null);
    if (!mainSource) return;
    this.suggesting.update(set => new Set(set).add(skill));
    this.suggestErrors.update(m => { const next = new Map(m); next.delete(skill); return next; });
    const ask = () => this.withSlot(() => this.post<SuggestResponse>('/suggest', { skill, main: mainSource.key, ...(fresh ? { fresh: true } : {}) }));
    try {
      let res: SuggestResponse;
      try { res = await ask(); }
      catch (e: any) {
        if (!retryBusy || e?.error?.error?.code !== 'BUSY') throw e;
        await this.sleep(SUGGEST_BUSY_RETRY_MS);
        res = await ask();
      }
      this.suggestions.update(m => new Map(m).set(skill, res.suggestions));
    } catch (e) { this.suggestErrors.update(m => new Map(m).set(skill, message(e))); }
    finally { this.suggesting.update(set => { const next = new Set(set); next.delete(skill); return next; }); }
  }

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
    if (this.applying()) return;
    if (this.changesLocked()) { this.trayOpen.set(true); return; }
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
    if (this.results()) { this.trayOpen.set(true); return; }
    const items = [...this.tray()];
    for (const change of changes) {
      const key = JSON.stringify(change);
      if (items.some(i => JSON.stringify(i.change) === key)) continue;
      items.push({ uid: ++this.uid, change, preview: null, error: '', deferred: false });
    }
    items.sort((a, b) => STAGE[a.change.kind] - STAGE[b.change.kind] || a.uid - b.uid);
    this.tray.set(this.markDeferred(items));
    void this.previewPending();
  }

  setTrayHidden(hidden: boolean) {
    this.trayHidden.set(hidden);
    saveChangesPreference(hidden ? 'hidden' : 'compact');
    this.trayOpen.set(false);
  }

  remove(uid: number) {
    if (this.changesLocked()) return;
    const rest = this.tray().filter(i => i.uid !== uid);
    this.tray.set(this.markDeferred(rest));
    if (!rest.length) this.trayOpen.set(false);
  }
  discard() { if (this.changesLocked()) return; this.clearChanges(); }

  /** An item is checked "as of now"; mark those whose real effect depends on earlier, unapplied items. */
  private markDeferred(items: TrayItem[]) {
    return items.map((item, i) => {
      const before = items.slice(0, i);
      const deferred = item.change.kind === 'library.rebuild' ? before.length > 0
        : item.change.kind === 'project.wire' ? before.some(b => ['library.rebuild', 'set.save'].includes(b.change.kind))
        : item.change.kind === 'source.fetch' ? before.some(b => b.change.kind === 'source.attach')
        : item.change.kind === 'project.adopt' ? before.some(b => b.change.kind === 'library.rebuild')
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
    return item.deferred && item.preview.conflicts.every(c => /library has not been built|No Git source called|has not been built yet|No set called|does not exist yet\. Wire the agent first/i.test(c));
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
          // The digests the server saw go with the change, so Apply sends what the person was shown.
          const pinned = item.change.kind === 'library.keep' ? { digests: preview.args?.['digests'] } : item.change.kind === 'library.rekeep' ? { digest: preview.args?.['digest'] } : {};
          const carried = Object.fromEntries(Object.entries(pinned).filter(([, v]) => v));
          this.tray.update(list => list.map(i => i.uid === uid ? { ...i, preview, ...(Object.keys(carried).length ? { change: { ...i.change, args: { ...i.change.args, ...carried } } } : {}) } : i));
        } catch (e) {
          // An item removed while it was being checked is no longer in the list, so these updates are no-ops.
          this.tray.update(list => list.map(i => i.uid === uid ? { ...i, error: message(e) } : i));
        }
      }
    } finally { this.previewing = false; }
  }
  private nextUnchecked() { return this.tray().find(i => !i.preview && !i.error); }

  /**
   * Runs the review sheet one step at a time, each as its own request. A single request has a time limit and a size
   * limit, and one check of an agent can take minutes; one step per request keeps every step inside both, lets the page
   * show progress, and means a list of a hundred checks is not refused for its length.
   * Each step is still planned again against the disk just before it runs. As on the server, a fetch or a check that
   * cannot be made does not cancel the others; any other step that cannot be made stops what follows.
   */
  async apply() {
    if (this.applying() || this.results() || this.blocked() || !this.tray().length) return;
    const items = this.tray();
    const results: ChangeResult[] = [];
    const resultFor = (item: TrayItem, status: ChangeResult['status'], why: string): ChangeResult => ({ kind: item.change.kind, title: item.preview?.title || item.change.kind, status, lines: [], message: why });
    this.runSteps.set(items.map(item => ({ item, startedAt: null, result: null })));
    const record = (index: number, outcome: ChangeResult) => {
      results.push(outcome);
      this.runSteps.update(steps => steps.map((step, i) => i === index ? { ...step, result: outcome } : step));
      this.applyProgress.set({ done: results.length, total: items.length });
    };
    this.applying.set(true); this.applyError.set(''); this.applyProgress.set({ done: 0, total: items.length });
    let stopped = false;
    try {
      for (const [i, item] of items.entries()) {
        if (stopped) { record(i, resultFor(item, 'skipped', 'Not run because an earlier change did not apply.')); continue; }
        this.activeStep.set(i);
        this.runSteps.update(steps => steps.map((step, j) => j === i ? { ...step, startedAt: Date.now() } : step));
        const res = await this.post<ApplyResponse>('/changes/apply', { changes: [item.change] });
        const outcome = res.results[0];
        record(i, outcome);
        if (outcome.status !== 'applied' && !INDEPENDENT.has(item.change.kind)) stopped = true;
      }
    } catch (e) {
      this.applyError.set(message(e));
      // Missing acknowledgement does not prove that the sent request did not apply.
      const uncertain = items[results.length];
      if (uncertain) record(results.length, resultFor(uncertain, 'uncertain', 'This change may have already applied, but its result was not received. Check the affected files or the agent\'s history before trying it again.'));
      for (const item of items.slice(results.length)) record(results.length, resultFor(item, 'skipped', 'This change was not sent because the previous outcome is unknown.'));
    } finally { this.activeStep.set(null); this.applyProgress.set(null); }
    this.results.set(results);
    this.applying.set(false);
    await this.refresh();
  }

  finish() { if (!this.applying()) this.clearChanges(); }
  private clearChanges() {
    this.results.set(null); this.tray.set([]); this.trayOpen.set(false); this.applyError.set(''); this.runSteps.set([]); this.activeStep.set(null);
  }

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
  /** Fetch several Git sources as one reviewed list: one fetch each and a single rebuild. Folders and the vault have nothing to fetch. */
  fetchMany(sources: Source[]) {
    const git = sources.filter(s => s.kind === 'git');
    if (!git.length) return;
    this.queue(...git.map(s => ({ kind: 'source.fetch' as const, args: { name: s.key } })), { kind: 'library.rebuild' });
  }
  rebuild() { this.queue({ kind: 'library.rebuild' }); }
  prefer(skill: string, source: Source | null) {
    this.queue({ kind: 'library.prefer', args: source && source.kind !== 'primary' ? { skill, source: source.key } : source ? { skill, source: 'vault' } : { skill } }, { kind: 'library.rebuild' });
  }
  /** Keep the differing copies under names of their own (`keep`), with `main` holding the plain name. */
  keep(skill: string, main: Source, keep: { source: Source; name: string; description: string }[]) {
    this.queue({ kind: 'library.keep', args: { skill, main: main.key, keep: keep.map(k => ({ source: k.source.key, name: k.name, description: k.description })) } }, { kind: 'library.rebuild' });
  }
  /** Accept that a kept copy's original changed: follow it as it is now, with a new description when one is given. */
  rekeep(name: string, description?: string) {
    this.queue({ kind: 'library.rekeep', args: description === undefined ? { name } : { name, description } }, { kind: 'library.rebuild' });
  }
  /** Stop keeping a copy under its own name. */
  unkeep(name: string) { this.queue({ kind: 'library.unkeep', args: { name } }, { kind: 'library.rebuild' }); }
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
  /** Ask several tools at once, as one reviewed list with one check each. The same check is never queued twice. */
  verifyMany(items: { projectId: string; target: string }[]) {
    if (!items.length) return;
    this.queue(...items.map(i => ({ kind: 'project.verify' as const, args: { projectId: i.projectId, target: i.target } })));
  }
  /** Save a set: create it, or with replace change the rules of one that exists. It is built when applied. */
  saveSet(name: string, rules: SetRule[], replace: boolean) { this.queue({ kind: 'set.save', args: { name, rules, replace } }); }
  removeSet(name: string) { this.queue({ kind: 'set.remove', args: { name } }); }
  /** Point one agent at a set, or with null back at the whole library. */
  readSet(projectId: string, target: TargetReport | string, set: string | null) {
    const id = typeof target === 'string' ? target : target.id;
    if (!set) { this.wire(projectId, [id], { writeDocs: false, repoint: true }); return; }
    this.queue({ kind: 'project.wire', args: { projectId, targets: [id], writeDocs: false, link: 'auto', repoint: true, set } });
  }
  /** Move a personal skill that hides a library one out of the way. Nothing is deleted. */
  setAside(tool: string, name: string) { this.queue({ kind: 'skill.setaside', args: { tool, name } }); }
  /** Put a set-aside skill back where it came from. */
  restoreSkill(tool: string, name: string) { this.queue({ kind: 'skill.restore', args: { tool, name } }); }
  /** Copy the library's missing skills in beside a project folder's own skills. */
  adopt(projectId: string, target: TargetReport | string) { this.queue({ kind: 'project.adopt', args: { projectId, target: typeof target === 'string' ? target : target.id } }); }
  copyFor(projectId: string, target: TargetReport) { this.wire(projectId, [target.id], { writeDocs: false, link: 'copy' }); }

  /** Changes waiting in the tray that touch a given thing, for ghost cables and badges. */
  pendingFor(kind: ChangeKind, match: (args: Record<string, unknown>) => boolean) {
    return this.tray().filter(i => i.change.kind === kind && match(i.change.args || {}));
  }
}
