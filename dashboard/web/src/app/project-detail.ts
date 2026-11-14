import { Component, computed, effect, inject, input, signal, untracked } from '@angular/core';
import { RouterLink } from '@angular/router';
import { AGENTS, Store, type ProjectReport, type TargetReport } from './store';
import { fitBudget, libraryEntries, resolveRules } from './set-rules';
import { DEFAULT_BUDGET_CHARS } from './sets';
import { adoptSummary } from './skill-actions';
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

  /** Adopting a folder of your own skills: which agent's folder is being looked at, before it is queued. */
  adopting = signal('');
  adoptingTarget = computed(() => this.report().targets.find(t => t.id === this.adopting() && t.adoptable) ?? null);
  adoptSummary = adoptSummary;
  plannedAdopt(target: string) { return this.s.pendingFor('project.adopt', a => a['projectId'] === this.id() && a['target'] === target).length > 0; }
  applyAdopt() {
    const t = this.adoptingTarget(); if (!t) return;
    this.s.adopt(this.id(), t);
    this.adopting.set('');
  }

  wiring = signal(false);
  wireTargets = signal<Set<string>>(new Set());
  wireDocs = signal(true);
  wireCopy = signal(false);

  // What an agent reads: the whole library, or one set. The choice is local until Review queues the change.
  choosing = signal('');
  choice = signal('');
  choosable = computed(() => (this.s.catalog()?.sets.length ?? 0) > 0
    ? this.shown().filter(t => ['library', 'set', 'vault', 'elsewhere'].includes(t.feeds) && !this.plannedFor(t.id)) : []);
  choosingTarget = computed(() => this.shown().find(t => t.id === this.choosing()) ?? null);
  options = computed(() => {
    const c = this.s.catalog(); if (!c) return [];
    const lib = libraryEntries(c), budget = c.health?.budget.budgetChars ?? DEFAULT_BUDGET_CHARS;
    const option = (value: string, label: string, entries: { chars: number }[]) => ({ value, label, count: entries.length, fit: fitBudget(entries.map(e => e.chars), budget) });
    return [option('', 'The whole library', lib), ...c.sets.map(set => option(set.name, set.name, resolveRules(set.rules, lib).entries))];
  });
  chosenOption = computed(() => this.options().find(o => o.value === this.choice()) ?? null);
  /** The agent currently reads this: the set's name, or empty for the library. */
  private current(t: TargetReport) { return t.feeds === 'set' ? t.set ?? '' : ''; }
  changed = computed(() => { const t = this.choosingTarget(); return !!t && this.choice() !== this.current(t); });
  preview = computed(() => {
    const t = this.choosingTarget(), o = this.chosenOption(), total = this.options()[0]?.count ?? 0;
    if (!t || !o) return '';
    const who = AGENTS[t.id] || t.id;
    return o.value
      ? `${t.dir}/skills will link to ~/.agentforge/views/${o.value}. ${who} will see ${o.count} skills. The other ${Math.max(0, total - o.count)} are not available in this project at all, not even by name.`
      : `${t.dir}/skills will link to the library. ${who} will see all ${total} skills.`;
  });
  openChoice(t: TargetReport) { this.choosing.set(t.id); this.choice.set(this.current(t)); }
  applyChoice() {
    const t = this.choosingTarget(); if (!t || !this.changed()) return;
    this.s.readSet(this.report().project.id, t, this.choice() || null);
    this.choosing.set('');
  }

  constructor() {
    // Choosing another project closes a half-filled wire form; a refresh of the same project does not.
    effect(() => { this.id(); untracked(() => { this.wiring.set(false); this.choosing.set(''); this.adopting.set(''); }); });
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
