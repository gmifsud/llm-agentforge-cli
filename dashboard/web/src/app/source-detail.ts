import { Component, computed, inject, input } from '@angular/core';
import { Router } from '@angular/router';
import { Store, type Source } from './store';
import { sourceLabel, sourceStatus } from './source-status';

/** One source: where it is, what state it is in, its place in the order, and the actions that change it. Each action queues a change. */
@Component({ selector: 'af-source-detail', template: `
  <h2 id="drawer-title" tabindex="-1">{{ label(source()) }}</h2>
  <p class="fine">{{ source().kind === 'primary' ? 'Your vault' : source().kind === 'git' ? 'Git repository' : 'Folder' }}</p>
  <p class="path">{{ source().kind === 'primary' ? source().root : source().location }}</p>
  <p class="state" [class.caution]="source().state === 'not-fetched'" [class.fault]="source().state !== 'available' && source().state !== 'not-fetched'">
    {{ status(source()) }}@if (source().revision) { <span class="rev">at {{ short(source().revision) }}</span> }
  </p>
  @if (source().kind === 'primary') { <p class="fine">Agentforge only reads this folder.</p> }
  @if (source().rejectionCount) { <p class="fine">{{ source().rejectionCount }} {{ source().rejectionCount === 1 ? 'entry was' : 'entries were' }} skipped. The Skills page lists them.</p> }
  @if (planned(); as p) { <p class="planned-note">{{ p }}</p> }

  @if (s.attached().length) {
    <section aria-label="Order">
      <p>Position {{ position() + 1 }} of {{ s.orderedSources().length }}. When two sources have the same skill, the one higher up wins.</p>
      @if (s.pendingOrder()) { <p class="planned-note">This order takes effect when you apply your changes.</p> }
      <div class="actions">
        <button type="button" class="quiet tiny" (click)="s.moveSource(source(), -1)" [disabled]="position() === 0 || s.applying()" [attr.aria-label]="'Move ' + label(source()) + ' up in the order'">Move up</button>
        <button type="button" class="quiet tiny" (click)="s.moveSource(source(), 1)" [disabled]="position() === s.orderedSources().length - 1 || s.applying()" [attr.aria-label]="'Move ' + label(source()) + ' down in the order'">Move down</button>
      </div>
    </section>
  }

  <div class="actions">
    <button type="button" class="quiet" (click)="showSkills()">Show its skills</button>
    @if (source().kind === 'git') { <button type="button" class="quiet" (click)="s.fetch(source())" [disabled]="s.applying()">Fetch updates</button> }
    @if (source().kind !== 'primary') { <button type="button" class="quiet" (click)="s.detach(source())" [disabled]="s.applying()">Detach</button> }
  </div>
` })
export class SourceDetail {
  s = inject(Store);
  private router = inject(Router);
  source = input.required<Source>();
  label = sourceLabel;
  status = sourceStatus;
  /** Place among all sources, whatever the list around it is showing. */
  position = computed(() => this.s.orderedSources().findIndex(x => x.id === this.source().id));
  planned = computed(() => {
    const src = this.source();
    return this.s.pendingFor('source.detach', a => a['name'] === src.key).length ? 'Will be detached'
      : this.s.pendingFor('source.fetch', a => a['name'] === src.key || !a['name']).length ? 'Will be fetched' : '';
  });
  short(rev: string | null) { return rev ? rev.slice(0, 7) : ''; }
  /** The Skills page, narrowed to this source. */
  showSkills() {
    this.s.view.set('all'); this.s.page.set(0); this.s.skillQuery.set(''); this.s.sourceFilter.set(this.source().id);
    void this.router.navigateByUrl('/library');
  }
}
