import { Component, ElementRef, OnDestroy, OnInit, afterRenderEffect, computed, inject, signal, untracked, viewChild } from '@angular/core';
import { Router, RouterLink } from '@angular/router';
import { AGENTS, Store, type Source, type ProjectReport, type TargetReport, type Collision, type SkillView } from './store';

interface Cable { id: string; d: string; tone: 'live' | 'caution' | 'fault' | 'planned' | 'idle'; stub: boolean }
type Tone = 'live' | 'caution' | 'fault' | 'muted';

/** How a person calls a skill in each tool. Claude Code's was exercised for real; the rest are from each tool's documentation. */
const INVOKE: Record<string, string> = {
  claude: 'Call a skill with /name',
  codex: 'Call a skill with $name, or pick one from /skills',
  gemini: 'Chosen by the agent. /skills list shows what it has',
  cursor: 'Type / and pick the skill',
  antigravity: 'Chosen by the agent; there is no direct command',
  generic: 'Read by Codex, Gemini CLI and Cursor',
};

@Component({ selector: 'af-board', imports: [RouterLink], templateUrl: './board.html' })
export class Board implements OnInit, OnDestroy {
  s = inject(Store);
  private router = inject(Router);
  agents = AGENTS;
  agentIds = Object.keys(AGENTS);
  invoke = INVOKE;
  private bay = viewChild<ElementRef<HTMLElement>>('bay');
  private observed: HTMLElement | null = null;
  cables = signal<Cable[]>([]);
  size = signal({ w: 0, h: 0 });
  animated = signal(false);
  private observer?: ResizeObserver;

  // Attach form
  attachOpen = signal(false);
  location = signal('');
  name = signal('');
  branch = signal('');
  isGit = computed(() => /^(https?:\/\/|ssh:\/\/|git@[^/:]+:)/i.test(this.location().trim()));
  suggestedName = computed(() => this.location().trim().replace(/[\\/]+$/, '').split(/[\\/:]/).pop()?.replace(/\.git$/i, '') || '');

  // Add project form
  projectOpen = signal(false);
  projectPath = signal('');

  // Wire editor
  wiring = signal<string>('');
  wireTargets = signal<Set<string>>(new Set());
  wireDocs = signal(true);
  wireCopy = signal(false);

  pendingAttach = computed(() => this.s.tray().filter(i => i.change.kind === 'source.attach'));
  pendingProjects = computed(() => this.s.tray().filter(i => i.change.kind === 'project.add'));
  /** At most five rows in the panel; the Skills page has the rest. */
  attentionRows = computed(() => this.s.attention().slice(0, 5));
  /** The order only matters, and is only shown, once there is something to order. */
  showOrder = computed(() => this.s.attached().length > 0);
  /** Worth showing once the library is big enough for the budget to bite, or whenever it already does. */
  showBudget = computed(() => { const h = this.s.catalog()?.health; return !!h && (!h.budget.fits || h.budget.entries > 50); });
  problemCount = computed(() => { const h = this.s.catalog()?.health; return h ? new Set(h.findings.filter(f => f.severity !== 'info').map(f => f.skillId)).size : 0; });

  constructor() {
    afterRenderEffect(() => {
      // Re-measure whenever anything that moves a socket changes.
      this.s.catalog(); this.s.tray(); this.attachOpen(); this.projectOpen(); this.wiring();
      untracked(() => this.draw());
    });
  }

  ngOnInit() { this.observer = new ResizeObserver(() => untracked(() => this.draw())); }
  ngOnDestroy() { this.observer?.disconnect(); }

  // ─── sources ───────────────────────────────────────────────────────────────
  label(src: Source) { return src.kind === 'primary' ? 'Your vault' : src.name; }
  plannedSource(source: Source) {
    return this.s.pendingFor('source.detach', a => a['name'] === source.key).length ? 'Will be detached'
      : this.s.pendingFor('source.fetch', a => a['name'] === source.key || !a['name']).length ? 'Will be fetched' : '';
  }
  sourceState(s: Source) {
    if (s.state === 'available') return s.count === 1 ? '1 skill' : `${s.count ?? 0} skills`;
    return { missing: 'Folder is missing', 'not-fetched': 'Not downloaded yet', unreadable: 'Cannot be read', rejected: 'Outside the allowed folders' }[s.state] || s.state;
  }
  short(rev: string | null) { return rev ? rev.slice(0, 7) : ''; }

  // ─── library ───────────────────────────────────────────────────────────────
  shade(i: number) { return `var(--mix-${Math.min(i, 5)})`; }
  libraryStatus() {
    const l = this.s.catalog()?.library; if (!l) return { text: '', tone: 'muted' };
    if (l.invalid) return { text: 'This folder holds files that are not links. Move them aside, then rebuild.', tone: 'fault' };
    if (!l.built) return { text: 'Not built yet. Build it before wiring projects.', tone: 'caution' };
    if (l.inSync === null) return { text: 'Cannot compare right now: a source is not available.', tone: 'caution' };
    if (l.inSync) return { text: 'Up to date', tone: 'live' };
    const parts = [l.add.length && `${l.add.length} to add`, l.change.length && `${l.change.length} to switch`, l.remove.length && `${l.remove.length} to remove`].filter(Boolean);
    return { text: `Out of date: ${parts.join(', ')}`, tone: 'caution' };
  }
  /** Share of descriptions an agent will actually be shown. Higher is better. */
  budgetPercent() { const b = this.s.catalog()?.health?.budget; if (!b) return 100; const described = b.entries - b.withoutDescription; return described ? Math.round((b.kept / described) * 100) : 100; }
  showSkills(view: SkillView) { this.s.view.set(view); this.s.page.set(0); this.s.sourceFilter.set(''); this.s.skillQuery.set(''); void this.router.navigateByUrl('/library'); }
  clashLine(col: Collision) {
    const c = this.s.catalog(); if (!c) return '';
    const winner = this.s.skillById(col.winnerId);
    const using = winner ? this.s.sourceName(winner.sourceId) : '';
    if (col.kind === 'changed') {
      const who = col.changedSourceIds.map(id => this.s.sourceName(id)).join(' and ');
      return `Using ${using}. ${who || 'A copy'} changed since you chose.`;
    }
    return col.candidateIds.map(id => this.s.skillById(id)).filter(Boolean).map(sk => this.s.sourceName(sk!.sourceId)).join(' and ');
  }
  plannedChoice(skill: string) { return this.s.pendingFor('library.prefer', a => a['skill'] === skill).length > 0; }

  // ─── projects ──────────────────────────────────────────────────────────────
  /** What an agent actually reads, in words, with the tone that colours its socket. */
  state(t: TargetReport): { text: string; tone: Tone } {
    switch (t.feeds) {
      case 'library': return { text: 'Reads the library', tone: 'live' };
      case 'vault': return { text: 'Reads your vault only', tone: 'caution' };
      case 'elsewhere': return { text: 'Reads another folder', tone: 'caution' };
      case 'broken': return { text: 'Link is broken', tone: 'fault' };
      case 'needs-copy': return { text: `Linked, but ${AGENTS[t.id]} does not follow links. It needs a copy`, tone: 'caution' };
      case 'copy':
        if (t.copy?.state === 'fresh') return { text: 'Has a copy of the library, up to date', tone: 'live' };
        if (t.copy?.state === 'stale') return { text: 'Its copy is out of date: the library changed since', tone: 'caution' };
        return { text: `Has its own folder (${t.entries ?? 0} skills), not managed here`, tone: 'muted' };
      case 'blocked': return { text: 'A file is in the way', tone: 'fault' };
      case 'unreadable': return { text: 'Cannot be read', tone: 'fault' };
      default: return { text: 'Not wired', tone: 'muted' };
    }
  }
  /** Skills reach the agent: show how to call one. */
  working(t: TargetReport) { return t.feeds === 'library' || (t.feeds === 'copy' && t.copy?.state === 'fresh'); }
  /** Agents worth a row: anything wired, broken, copied or about to be wired. */
  shown(report: ProjectReport) { return report.targets.filter(t => t.feeds !== 'none' || this.plannedFor(report.project.id, t.id)); }
  /** Opt-in agents are offered in the wire form, not listed here as missing. */
  unwired(report: ProjectReport) { return report.targets.filter(t => t.feeds === 'none' && !t.optIn && !this.plannedFor(report.project.id, t.id)).map(t => AGENTS[t.id]).join(', '); }
  needsRepoint(t: TargetReport) { return t.feeds === 'vault' || t.feeds === 'elsewhere' || t.feeds === 'broken'; }
  needsCopy(t: TargetReport) { return t.feeds === 'needs-copy'; }
  staleCopy(t: TargetReport) { return t.feeds === 'copy' && t.copy?.state === 'stale'; }
  plannedFor(projectId: string, target: string) {
    return this.s.pendingFor('project.wire', a => a['projectId'] === projectId && Array.isArray(a['targets']) && (a['targets'] as string[]).includes(target)).length > 0;
  }

  // ─── actions ───────────────────────────────────────────────────────────────
  submitAttach(event: Event) {
    event.preventDefault();
    const location = this.location().trim(); if (!location) return;
    this.s.attach(location, this.name().trim(), this.branch().trim());
    this.attachOpen.set(false); this.location.set(''); this.name.set(''); this.branch.set('');
  }
  submitProject(event: Event) {
    event.preventDefault();
    const p = this.projectPath().trim(); if (!p) return;
    this.s.addProject(p); this.projectOpen.set(false); this.projectPath.set('');
  }
  openWire(report: ProjectReport) {
    const keep = report.targets.filter(t => this.working(t)).map(t => t.id);
    this.wireTargets.set(new Set(keep.length ? keep : ['claude']));
    this.wireDocs.set(true); this.wireCopy.set(false);
    this.wiring.set(report.project.id);
  }
  toggleTarget(id: string, on: boolean) { const next = new Set(this.wireTargets()); if (on) next.add(id); else next.delete(id); this.wireTargets.set(next); }
  submitWire(event: Event, report: ProjectReport) {
    event.preventDefault();
    const targets = this.agentIds.filter(id => this.wireTargets().has(id)); if (!targets.length) return;
    this.s.wire(report.project.id, targets, { writeDocs: this.wireDocs(), link: this.wireCopy() ? 'copy' : 'auto' });
    this.wiring.set('');
  }

  // ─── cables ────────────────────────────────────────────────────────────────
  private draw() {
    const host = this.bay()?.nativeElement; if (!host) return;
    if (this.observed !== host) { if (this.observed) this.observer?.unobserve(this.observed); this.observer?.observe(host); this.observed = host; }
    const box = host.getBoundingClientRect();
    this.size.set({ w: Math.round(box.width), h: Math.round(box.height) });
    if (getComputedStyle(host).getPropertyValue('--cables').trim() === 'off') { this.cables.set([]); return; }
    const jack = (key: string) => {
      const el = host.querySelector<HTMLElement>(`[data-jack="${CSS.escape(key)}"]`); if (!el) return null;
      const r = el.getBoundingClientRect(); return { x: r.left + r.width / 2 - box.left, y: r.top + r.height / 2 - box.top };
    };
    const curve = (a: { x: number; y: number }, b: { x: number; y: number }) => {
      const dx = Math.max(36, (b.x - a.x) * 0.5);
      return `M${a.x.toFixed(1)},${a.y.toFixed(1)} C${(a.x + dx).toFixed(1)},${a.y.toFixed(1)} ${(b.x - dx).toFixed(1)},${b.y.toFixed(1)} ${b.x.toFixed(1)},${b.y.toFixed(1)}`;
    };
    const stub = (b: { x: number; y: number }) => `M${(b.x - 64).toFixed(1)},${b.y.toFixed(1)} L${b.x.toFixed(1)},${b.y.toFixed(1)}`;
    const c = this.s.catalog(); const out: Cable[] = [];
    const libIn = jack('lib-in'), libOut = jack('lib-out');
    if (c && libIn && libOut) {
      const contributing = new Set(this.s.contribution().map(x => x.source.id));
      for (const src of c.sources) {
        const a = jack(`src:${src.id}`); if (!a) continue;
        const live = src.state === 'available' && contributing.has(src.id);
        const leaving = this.plannedSource(src) === 'Will be detached';
        out.push({ id: `src:${src.id}`, d: curve(a, libIn), tone: leaving ? 'planned' : live ? 'live' : 'idle', stub: false });
      }
      for (const item of this.pendingAttach()) {
        const a = jack(`ghost:${item.uid}`); if (a) out.push({ id: `ghost:${item.uid}`, d: curve(a, libIn), tone: 'planned', stub: false });
      }
      const vault = c.sources.find(s => s.kind === 'primary');
      for (const report of c.projects) {
        for (const t of report.targets) {
          const b = jack(`tgt:${report.project.id}:${t.id}`); if (!b) continue;
          const id = `tgt:${report.project.id}:${t.id}`;
          if (this.plannedFor(report.project.id, t.id)) { out.push({ id, d: curve(libOut, b), tone: 'planned', stub: false }); continue; }
          // A cable means "this feeds that". A copy carries skills but is not connected, so it gets a socket state and no cable.
          if (t.feeds === 'library') out.push({ id, d: curve(libOut, b), tone: 'live', stub: false });
          else if (t.feeds === 'vault' && vault) { const a = jack(`src:${vault.id}`); if (a) out.push({ id, d: curve(a, b), tone: 'caution', stub: false }); }
          else if (t.feeds === 'elsewhere' || t.feeds === 'needs-copy') out.push({ id, d: stub(b), tone: 'caution', stub: true });
          else if (t.feeds === 'broken') out.push({ id, d: stub(b), tone: 'fault', stub: true });
        }
      }
    }
    const prev = this.cables();
    if (prev.length !== out.length || prev.some((p, i) => p.d !== out[i].d || p.tone !== out[i].tone)) this.cables.set(out);
    if (!this.animated() && out.length) setTimeout(() => this.animated.set(true), 900);
  }
}
