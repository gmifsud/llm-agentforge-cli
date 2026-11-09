import { Component, ElementRef, OnDestroy, OnInit, afterRenderEffect, computed, inject, signal, untracked, viewChild } from '@angular/core';
import { RouterLink } from '@angular/router';
import { AGENTS, Store, type Source, type ProjectReport, type TargetReport, type Feeds } from './store';

interface Cable { id: string; d: string; tone: 'live' | 'caution' | 'fault' | 'planned' | 'idle'; stub: boolean }

const FEEDS: Record<Feeds, { text: string; tone: 'live' | 'caution' | 'fault' | 'muted' }> = {
  library: { text: 'Reads the library', tone: 'live' },
  vault: { text: 'Reads your vault only', tone: 'caution' },
  elsewhere: { text: 'Reads another folder', tone: 'caution' },
  broken: { text: 'Link is broken', tone: 'fault' },
  copy: { text: 'Has its own copy', tone: 'muted' },
  blocked: { text: 'A file is in the way', tone: 'fault' },
  unreadable: { text: 'Cannot be read', tone: 'fault' },
  none: { text: 'Not wired', tone: 'muted' },
};

@Component({ selector: 'af-board', imports: [RouterLink], templateUrl: './board.html' })
export class Board implements OnInit, OnDestroy {
  s = inject(Store);
  agents = AGENTS;
  agentIds = Object.keys(AGENTS);
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

  // Collisions
  showAllCollisions = signal(false);
  collisions = computed(() => {
    const all = this.s.catalog()?.collisions || [];
    return this.showAllCollisions() ? all : all.slice(0, 5);
  });

  pendingAttach = computed(() => this.s.tray().filter(i => i.change.kind === 'source.attach'));
  pendingProjects = computed(() => this.s.tray().filter(i => i.change.kind === 'project.add'));

  constructor() {
    afterRenderEffect(() => {
      // Re-measure whenever anything that moves a socket changes.
      this.s.catalog(); this.s.tray(); this.attachOpen(); this.projectOpen(); this.wiring(); this.showAllCollisions();
      untracked(() => this.draw());
    });
  }

  ngOnInit() {
    this.observer = new ResizeObserver(() => untracked(() => this.draw()));
  }
  ngOnDestroy() { this.observer?.disconnect(); }

  feeds(t: TargetReport) { return FEEDS[t.feeds]; }
  /** Agents worth a row: anything wired, broken, copied or about to be wired. */
  shown(report: ProjectReport) { return report.targets.filter(t => t.feeds !== 'none' || this.plannedFor(report.project.id, t.id)); }
  unwired(report: ProjectReport) { return report.targets.filter(t => t.feeds === 'none' && !this.plannedFor(report.project.id, t.id)).map(t => AGENTS[t.id]).join(', '); }
  needsRepoint(t: TargetReport) { return t.feeds === 'vault' || t.feeds === 'elsewhere' || t.feeds === 'broken'; }
  plannedFor(projectId: string, target: string) {
    return this.s.pendingFor('project.wire', a => a['projectId'] === projectId && Array.isArray(a['targets']) && (a['targets'] as string[]).includes(target)).length > 0;
  }
  plannedSource(source: Source) {
    return this.s.pendingFor('source.detach', a => a['name'] === source.key).length ? 'Will be detached'
      : this.s.pendingFor('source.fetch', a => a['name'] === source.key || !a['name']).length ? 'Will be fetched' : '';
  }
  plannedChoice(skill: string) { return this.s.pendingFor('library.prefer', a => a['skill'] === skill)[0]?.change.args?.['source'] as string | undefined; }
  sourceState(s: Source) {
    if (s.state === 'available') return s.count === 1 ? '1 skill' : `${s.count ?? 0} skills`;
    return { missing: 'Folder is missing', 'not-fetched': 'Not downloaded yet', unreadable: 'Cannot be read', rejected: 'Outside the allowed folders' }[s.state] || s.state;
  }
  short(rev: string | null) { return rev ? rev.slice(0, 7) : ''; }
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
    const keep = report.targets.filter(t => t.feeds === 'library').map(t => t.id);
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
  choose(skill: string, sourceId: string) { this.s.prefer(skill, this.s.sourceById(sourceId)); }

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
          if (t.feeds === 'library') out.push({ id, d: curve(libOut, b), tone: 'live', stub: false });
          else if (t.feeds === 'vault' && vault) { const a = jack(`src:${vault.id}`); if (a) out.push({ id, d: curve(a, b), tone: 'caution', stub: false }); }
          else if (t.feeds === 'elsewhere') out.push({ id, d: `M${(b.x - 64).toFixed(1)},${b.y.toFixed(1)} L${b.x.toFixed(1)},${b.y.toFixed(1)}`, tone: 'caution', stub: true });
          else if (t.feeds === 'broken') out.push({ id, d: `M${(b.x - 64).toFixed(1)},${b.y.toFixed(1)} L${b.x.toFixed(1)},${b.y.toFixed(1)}`, tone: 'fault', stub: true });
        }
      }
    }
    const prev = this.cables();
    if (prev.length !== out.length || prev.some((p, i) => p.d !== out[i].d || p.tone !== out[i].tone)) this.cables.set(out);
    if (!this.animated() && out.length) setTimeout(() => this.animated.set(true), 900);
  }
}
