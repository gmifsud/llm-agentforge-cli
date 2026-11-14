import { Component, ElementRef, OnDestroy, OnInit, afterRenderEffect, computed, inject, signal, untracked, viewChild } from '@angular/core';
import { ActivatedRoute, RouterLink } from '@angular/router';
import { toSignal } from '@angular/core/rxjs-interop';
import { MAP_PAGE, mapScope } from './map-scope';
import { AGENTS, Store, type Source, type ProjectReport } from './store';
import { LibraryCard } from './library-card';

import { sourceLabel, sourceStatus } from './source-status';
import { INVOKE, agentState, isVerified, isWorking, needsCopy, needsRepoint, staleCopy, unwiredNames, verifiedLine } from './agent-status';

interface Cable { id: string; d: string; tone: 'live' | 'caution' | 'fault' | 'planned' | 'idle'; stub: boolean }

@Component({ selector: 'af-board', imports: [RouterLink, LibraryCard], templateUrl: './board.html' })
export class Board implements OnInit, OnDestroy {
  s = inject(Store);
  private route = inject(ActivatedRoute);
  agents = AGENTS;

  /** The map draws one project or one folder, chosen in Fleet, so cables stay readable however many projects there are. */
  pageSize = MAP_PAGE;
  private query = toSignal(this.route.queryParamMap, { requireSync: true });
  groupKey = computed(() => this.query().get('group') || '');
  scope = computed(() => mapScope(this.s.catalog()?.projects ?? [], { project: this.query().get('project'), group: this.query().get('group'), page: this.query().get('page') }));
  /** The projects whose cables are drawn. */
  projects = computed(() => this.scope().reports);
  /** With nothing chosen, or something that is gone, no board is drawn. */
  showBay = computed(() => this.scope().kind === 'project' || this.scope().kind === 'group');
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

  // Wire editor
  wiring = signal<string>('');
  wireTargets = signal<Set<string>>(new Set());
  wireDocs = signal(true);
  wireCopy = signal(false);

  pendingAttach = computed(() => this.s.tray().filter(i => i.change.kind === 'source.attach'));
  /** The order only matters, and is only shown, once there is something to order. */
  showOrder = computed(() => this.s.attached().length > 0);

  constructor() {
    afterRenderEffect(() => {
      // Re-measure whenever anything that moves a socket changes.
      this.s.catalog(); this.s.tray(); this.attachOpen(); this.wiring(); this.projects();
      untracked(() => this.draw());
    });
  }

  ngOnInit() { this.observer = new ResizeObserver(() => untracked(() => this.draw())); }
  ngOnDestroy() { this.observer?.disconnect(); }

  // ─── sources ───────────────────────────────────────────────────────────────
  label = sourceLabel;
  plannedSource(source: Source) {
    return this.s.pendingFor('source.detach', a => a['name'] === source.key).length ? 'Will be detached'
      : this.s.pendingFor('source.fetch', a => a['name'] === source.key || !a['name']).length ? 'Will be fetched' : '';
  }
  sourceState = sourceStatus;
  short(rev: string | null) { return rev ? rev.slice(0, 7) : ''; }

  // ─── projects ──────────────────────────────────────────────────────────────
  // Wording and rules for one agent live in agent-status.ts, shared with the fleet view.
  state = agentState;
  verified = verifiedLine;
  isVerified = isVerified;
  working = isWorking;
  needsRepoint = needsRepoint;
  needsCopy = needsCopy;
  staleCopy = staleCopy;
  plannedVerify(projectId: string, target: string) { return this.s.pendingFor('project.verify', a => a['projectId'] === projectId && a['target'] === target).length > 0; }

  /** Agents worth a row: anything wired, broken, copied or about to be wired. */
  shown(report: ProjectReport) { return report.targets.filter(t => t.feeds !== 'none' || this.plannedFor(report.project.id, t.id)); }
  unwired(report: ProjectReport) { return unwiredNames(report, id => this.plannedFor(report.project.id, id)); }
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
      for (const report of this.projects()) {
        for (const t of report.targets) {
          const b = jack(`tgt:${report.project.id}:${t.id}`); if (!b) continue;
          const id = `tgt:${report.project.id}:${t.id}`;
          if (this.plannedFor(report.project.id, t.id)) { out.push({ id, d: curve(libOut, b), tone: 'planned', stub: false }); continue; }
          // A cable means "this feeds that". A copy carries skills but is not connected, so it gets a socket state and no cable.
          if (t.feeds === 'library' || t.feeds === 'set') out.push({ id, d: curve(libOut, b), tone: 'live', stub: false });
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
