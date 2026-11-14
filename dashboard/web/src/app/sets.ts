import { Component, computed, inject } from '@angular/core';
import { RouterLink } from '@angular/router';
import { Store, type TargetReport } from './store';
import { fitBudget, libraryEntries, resolveRules, type Fit } from './set-rules';

/** The listing budget in characters, from the server's estimate; the default is the estimator's own. */
export const DEFAULT_BUDGET_CHARS = 8000;

@Component({ selector: 'af-sets', imports: [RouterLink], template: `
  <header class="page-head">
    <h1>Sets</h1>
    <p>A set is a shortlist of your library. An agent that reads a set sees every one of its descriptions, so it can choose among them on its own.</p>
  </header>
  @if (s.catalog(); as c) {
    <div class="pane-head" style="margin-bottom:.9rem">
      <span class="fine">{{ c.sets.length }} {{ c.sets.length === 1 ? 'set' : 'sets' }}, {{ onSets() }} {{ onSets() === 1 ? 'agent reads' : 'agents read' }} one</span>
      <a class="button primary" routerLink="/sets/new">Create a set</a>
    </div>
    <section class="list" aria-label="Sets">
      <table>
        <thead><tr><th scope="col">Name</th><th scope="col">Skills</th><th scope="col" style="width:36%">What agents will see</th><th scope="col">Read by</th><th scope="col"></th></tr></thead>
        <tbody>
          <tr class="whole-library">
            <td><strong>The whole library</strong> <span class="tag">all sources · cannot be deleted</span></td>
            <td>{{ library().length }}</td>
            <td><div class="budget plain"><div class="meter"><span [style.width.%]="percent(libraryFit())" [class.over]="!libraryFit().fits"></span></div><span class="fine" [class.warn]="!libraryFit().fits">{{ fitText(libraryFit()) }}</span></div></td>
            <td>{{ readers('library') }} {{ readers('library') === 1 ? 'agent' : 'agents' }}</td>
            <td></td>
          </tr>
          @for (row of rows(); track row.name) {
            <tr>
              <td>
                <a class="row-button" [routerLink]="['/sets', row.name]">{{ row.name }}</a>
                <span class="tag">{{ row.rules }} {{ row.rules === 1 ? 'rule' : 'rules' }}</span>
                @if (!row.built) { <span class="pill caution">Not built yet</span> }
                @if (row.unmatched) { <span class="pill caution">{{ row.unmatched }} {{ row.unmatched === 1 ? 'rule selects' : 'rules select' }} nothing</span> }
                @if (row.removing) { <span class="planned-note">Will be removed when you apply</span> }
              </td>
              <td>{{ row.count }}</td>
              <td><div class="budget plain"><div class="meter"><span [style.width.%]="percent(row.fit)" [class.over]="!row.fit.fits"></span></div><span class="fine" [class.warn]="!row.fit.fits">{{ fitText(row.fit) }}</span></div></td>
              <td>{{ row.readers }} {{ row.readers === 1 ? 'agent' : 'agents' }}</td>
              <td>
                <button type="button" class="quiet tiny" (click)="s.removeSet(row.name)" [disabled]="s.applying() || row.readers > 0 || row.removing"
                        [title]="row.readers ? 'Agents read this set. Point them elsewhere first.' : ''" [attr.aria-label]="'Delete the set ' + row.name">Delete</button>
              </td>
            </tr>
          }
        </tbody>
      </table>
      @if (!c.sets.length) { <p class="empty">No sets yet. Create one to give an agent fewer skills, so every description fits.</p> }
      <p class="fine" style="margin-top:.8rem">A set that an agent reads cannot be deleted until the agent reads something else. Skills outside a set are not available to an agent that reads it, not even by name.</p>
    </section>
  } @else if (!s.busy()) {
    <p class="empty-state">The dashboard could not read your workspace yet. Use Refresh to try again.</p>
  }
` })
export class Sets {
  s = inject(Store);
  library = computed(() => { const c = this.s.catalog(); return c ? libraryEntries(c) : []; });
  budgetChars = computed(() => this.s.catalog()?.health?.budget.budgetChars ?? DEFAULT_BUDGET_CHARS);
  libraryFit = computed(() => fitBudget(this.library().map(e => e.chars), this.budgetChars()));
  rows = computed(() => (this.s.catalog()?.sets ?? []).map(set => {
    const r = resolveRules(set.rules, this.library());
    return {
      name: set.name, rules: set.rules.length, built: set.built, count: r.entries.length, unmatched: r.unmatched.length,
      fit: fitBudget(r.entries.map(e => e.chars), this.budgetChars()), readers: this.readers(set.name),
      removing: this.s.pendingFor('set.remove', a => a['name'] === set.name).length > 0,
    };
  }));
  onSets = computed(() => this.count(t => t.feeds === 'set'));

  /** Agents reading the library (name 'library') or one set. */
  readers(name: string) { return this.count(t => (name === 'library' ? t.feeds === 'library' : t.feeds === 'set' && t.set === name)); }
  private count(match: (t: TargetReport) => boolean) { return (this.s.catalog()?.projects ?? []).reduce((n, p) => n + p.targets.filter(match).length, 0); }

  percent(f: Fit) { const described = f.kept + f.dropped; return f.fits || !described ? 100 : Math.round((f.kept / described) * 100); }
  fitText(f: Fit) { return f.fits ? 'Every description fits' : `About ${f.kept} of ${f.kept + f.dropped} descriptions fit`; }
}
