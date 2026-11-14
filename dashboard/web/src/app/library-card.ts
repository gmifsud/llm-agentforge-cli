import { Component, computed, inject, input } from '@angular/core';
import { Router, RouterLink } from '@angular/router';
import { Store, type Collision, type SkillView } from './store';
import { sourceLabel } from './source-status';

/**
 * The library and its same-name clashes: how many skills your agents can use, whether the library on disk is current,
 * what fits the listing budget, and which clashes need a look. Shown on the Fleet page, and on the map with `sockets`,
 * where cables plug into the library card.
 */
@Component({ selector: 'af-library-card', imports: [RouterLink], template: `
  @if (s.catalog(); as c) {
    <article class="module library" aria-label="Library">
      @if (sockets()) { <span class="jack in" data-jack="lib-in"></span> }
      <div class="library-total">
        <strong>{{ s.libraryTotal() }}</strong>
        <span>{{ s.libraryTotal() === 1 ? 'skill' : 'skills' }} from {{ s.contribution().length }} {{ s.contribution().length === 1 ? 'source' : 'sources' }}</span>
      </div>
      @if (s.contribution().length > 1) {
        <div class="mix" role="img" [attr.aria-label]="'Library made of ' + s.contribution().length + ' sources'">
          @for (part of s.contribution(); track part.source.id; let i = $index) {
            <span [style.flex-grow]="part.count" [style.background]="shade(i)"></span>
          }
        </div>
        <ul class="legend">
          @for (part of s.contribution(); track part.source.id; let i = $index) {
            <li><span class="swatch" [style.background]="shade(i)"></span>{{ label(part.source) }} <b>{{ part.count }}</b></li>
          }
        </ul>
      }
      @if (libraryStatus(); as st) { <p class="state" [class]="'state ' + st.tone" role="status">{{ st.text }}</p> }
      @if (since(); as rows) {
        <details class="since">
          <summary>Since the last build: {{ sinceSummary() }}</summary>
          @for (row of rows; track row.label) { <p class="fine"><b>{{ row.label }}</b> {{ row.names }}</p> }
        </details>
      }
      <p class="path">{{ c.library.path }}</p>

      @if (c.health; as h) {
        @if (showBudget()) {
          <div class="budget" [class.over]="!h.budget.fits">
            <h4 id="h-budget">What your agents will see</h4>
            <div class="meter" role="img" [attr.aria-label]="budgetPercent() + ' percent of skill descriptions fit'"><span [style.width.%]="budgetPercent()"></span></div>
            @if (h.budget.fits) {
              <p class="fine">Every description fits, so agents can pick any of these skills on their own.</p>
            } @else {
              <p>About {{ h.budget.kept }} of {{ h.budget.entries }} descriptions fit. The rest can still be called by name, but agents will not pick them on their own.</p>
              <details><summary>Why this matters</summary>
                <p class="fine">An agent chooses a skill by reading its description. Tools only load descriptions up to a budget; past it, the least-used are left out. Wiring fewer skills into a project keeps more of them visible.</p>
              </details>
            }
          </div>
        }
        @if (problemCount()) {
          <p class="health-line"><span class="state caution">{{ problemCount() }} {{ problemCount() === 1 ? 'skill has a problem' : 'skills have problems' }} in some tools</span>
            <button type="button" class="quiet tiny" (click)="showSkills('problems')">Show</button></p>
        }
        @if (h.shadows.length) {
          <p class="health-line"><span class="state caution">{{ h.shadows.length }} personal {{ h.shadows.length === 1 ? 'skill hides' : 'skills hide' }} a library skill of the same name</span>
            <button type="button" class="quiet tiny" (click)="showSkills('problems')">Show</button></p>
        }
      }

      @if (c.sets.length) {
        <p class="health-line"><span class="state live">Sets: {{ c.sets.length }} · {{ setStats().onSets }} {{ setStats().onSets === 1 ? 'agent reads' : 'agents read' }} a set · {{ setStats().onLibrary }} read the whole library</span>
          <a class="button quiet tiny" routerLink="/sets">Manage sets</a></p>
      } @else if (c.health && !c.health.budget.fits) {
        <p class="health-line"><span class="fine">No sets yet. A set gives an agent fewer skills, so every description fits.</span>
          <a class="button quiet tiny" routerLink="/sets/new">Create a set</a></p>
      }

      <div class="actions">
        <button type="button" [class.primary]="c.library.inSync === false || !c.library.built" [class.quiet]="c.library.inSync !== false && c.library.built"
                (click)="s.rebuild()" [disabled]="s.applying()">{{ c.library.built ? 'Rebuild the library' : 'Build the library' }}</button>
        <a routerLink="/library" class="link">Browse all skills</a>
      </div>
      @if (sockets()) { <span class="jack out" data-jack="lib-out"></span> }
    </article>

    @if (s.clashCounts(); as n) {
      @if (n.total) {
        <article class="module clashes" aria-labelledby="h-clashes">
          <h3 id="h-clashes">Same name, more than one source</h3>
          <ul class="clash-summary">
            @if (n.changed) { <li class="caution"><b>{{ n.changed }}</b> changed since you chose</li> }
            @if (n.needs) { <li><b>{{ n.needs }}</b> {{ n.needs === 1 ? 'needs' : 'need' }} a look <span class="fine">only the default order decided</span></li> }
            @if (n.decided) { <li class="muted"><b>{{ n.decided }}</b> decided <span class="fine">by your source order, or by you</span></li> }
            @if (n.identical) { <li class="muted"><b>{{ n.identical }}</b> identical {{ n.identical === 1 ? 'copy' : 'copies' }} <span class="fine">nothing to decide</span></li> }
          </ul>
          @for (col of attentionRows(); track col.name) {
            <div class="clash-row">
              <div>
                <strong>{{ col.name }}</strong>
                <span class="fine">{{ clashLine(col) }}</span>
                @if (plannedChoice(col.name)) { <span class="planned-note">Changes when you apply</span> }
              </div>
              <a class="button quiet tiny" [routerLink]="['/compare', col.name]" [attr.aria-label]="'Compare the copies of ' + col.name">Compare</a>
            </div>
          }
          @if (s.attention().length > 5 || n.decided) {
            <div class="actions"><button type="button" class="quiet tiny" (click)="showSkills(s.attention().length > 5 ? 'attention' : 'collisions')">{{ s.attention().length > 5 ? 'Show all ' + s.attention().length : 'See every clash' }}</button></div>
          }
        </article>
      }
    }
  }
` })
export class LibraryCard {
  s = inject(Store);
  private router = inject(Router);
  /** Draw cable sockets on the card; the map needs them, the Fleet page does not. */
  sockets = input(false);
  label = sourceLabel;

  /** At most five rows in the panel; the Skills page has the rest. */
  attentionRows = computed(() => this.s.attention().slice(0, 5));
  /** Worth showing once the library is big enough for the budget to bite, or whenever it already does. */
  showBudget = computed(() => { const h = this.s.catalog()?.health; return !!h && (!h.budget.fits || h.budget.entries > 50); });
  problemCount = computed(() => { const h = this.s.catalog()?.health; return h ? new Set(h.findings.filter(f => f.severity !== 'info').map(f => f.skillId)).size : 0; });

  /** What changed in the sources since the last build, when there is a record to compare with and something to say. */
  since = computed(() => {
    const s = this.s.catalog()?.sinceLastBuild;
    if (!s || s.first) return null;
    const groups: [string, string[]][] = [['Added', s.added], ['Removed', s.removed], ['Content changed', s.changed], ['Moved to another source', s.moved]];
    const rows = groups.filter(([, names]) => names.length)
      .map(([label, names]) => ({ label, count: names.length, names: names.slice(0, 12).join(', ') + (names.length > 12 ? ` and ${names.length - 12} more` : '') }));
    return rows.length ? rows : null;
  });
  sinceSummary = computed(() => (this.since() ?? []).map(r => `${r.count} ${r.label.toLowerCase()}`).join(', '));

  /** How many agents read a set, and how many read the whole library. */
  setStats = computed(() => {
    const targets = (this.s.catalog()?.projects ?? []).flatMap(p => p.targets);
    return { onSets: targets.filter(t => t.feeds === 'set').length, onLibrary: targets.filter(t => t.feeds === 'library').length };
  });

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
}
