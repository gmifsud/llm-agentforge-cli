import { Component, computed, effect, inject, input, signal, untracked } from '@angular/core';
import { RouterLink } from '@angular/router';
import { AGENTS, Store, type ProjectReport } from './store';
import { INVOKE, agentState, isVerified, isWorking, needsCopy, needsRepoint, staleCopy, unwiredNames, verifiedLine } from './agent-status';

/**
 * Everything about one project: what each agent reads, the actions that fix it, and the wire form.
 * Every action queues a change in the review sheet; nothing here writes.
 */
@Component({ selector: 'af-project-detail', templateUrl: './project-detail.html', imports: [RouterLink] })
export class ProjectDetail {
  s = inject(Store);
  report = input.required<ProjectReport>();
  agents = AGENTS;
  agentIds = Object.keys(AGENTS);
  invoke = INVOKE;

  state = agentState;
  verified = verifiedLine;
  isVerified = isVerified;
  working = isWorking;
  needsRepoint = needsRepoint;
  needsCopy = needsCopy;
  staleCopy = staleCopy;

  private id = computed(() => this.report().project.id);
  /** Agents worth a row: anything wired, broken, copied or about to be wired. */
  shown = computed(() => this.report().targets.filter(t => t.feeds !== 'none' || this.plannedFor(t.id)));
  unwired = computed(() => unwiredNames(this.report(), t => this.plannedFor(t)));

  wiring = signal(false);
  wireTargets = signal<Set<string>>(new Set());
  wireDocs = signal(true);
  wireCopy = signal(false);

  constructor() {
    // Choosing another project closes a half-filled wire form; a refresh of the same project does not.
    effect(() => { this.id(); untracked(() => this.wiring.set(false)); });
  }

  plannedFor(target: string) {
    return this.s.pendingFor('project.wire', a => a['projectId'] === this.id() && Array.isArray(a['targets']) && (a['targets'] as string[]).includes(target)).length > 0;
  }
  plannedVerify(target: string) { return this.s.pendingFor('project.verify', a => a['projectId'] === this.id() && a['target'] === target).length > 0; }

  openWire() {
    const keep = this.report().targets.filter(t => this.working(t)).map(t => t.id);
    this.wireTargets.set(new Set(keep.length ? keep : ['claude']));
    this.wireDocs.set(true); this.wireCopy.set(false);
    this.wiring.set(true);
  }
  toggleTarget(id: string, on: boolean) { const next = new Set(this.wireTargets()); if (on) next.add(id); else next.delete(id); this.wireTargets.set(next); }
  submitWire(event: Event) {
    event.preventDefault();
    const targets = this.agentIds.filter(id => this.wireTargets().has(id)); if (!targets.length) return;
    this.s.wire(this.id(), targets, { writeDocs: this.wireDocs(), link: this.wireCopy() ? 'copy' : 'auto' });
    this.wiring.set(false);
  }
}
