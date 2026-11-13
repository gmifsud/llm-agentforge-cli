import { Component, computed, inject } from '@angular/core';
import { Store } from './store';
import { pendingChecks } from './project-status';

const TONE_LABEL: Record<string, string> = { add: 'Adds', remove: 'Removes', change: 'Changes', note: 'Note', warn: 'Check' };
const STATUS_LABEL: Record<string, string> = { applied: 'Applied', refused: 'Refused', failed: 'Failed', skipped: 'Not run' };

@Component({ selector: 'af-tray', template: `
  @if (s.tray().length || s.results()) {
    <aside class="tray" [class.open]="s.trayOpen()" aria-labelledby="tray-title">
      <div class="tray-bar">
        <button type="button" class="tray-toggle" (click)="s.trayOpen.set(!s.trayOpen())" [attr.aria-expanded]="s.trayOpen()" aria-controls="tray-body">
          <span id="tray-title">{{ heading() }}</span>
        </button>
        <div class="tray-actions">
          @if (s.results()) {
            <button type="button" class="primary" (click)="s.finish()">Done</button>
          } @else {
            <button type="button" class="quiet" (click)="s.discard()" [disabled]="s.applying()">Discard all</button>
            <button type="button" class="primary" (click)="s.apply()" [disabled]="s.applying() || s.blocked() || s.checking()">
              {{ s.applying() ? 'Applying…' : 'Apply ' + count(s.tray().length) }}
            </button>
          }
        </div>
      </div>
      @if (s.trayOpen()) {
        <div class="tray-body" id="tray-body">
          @if (s.applyError()) { <p class="notice fault" role="alert">{{ s.applyError() }}</p> }
          @if (!s.results() && checks()) {
            <p class="fine">{{ checks() }} {{ checks() === 1 ? 'check asks' : 'checks ask' }} an agent's own tool whether it sees the skills. Most send one short question, on your account. Nothing runs until you press Apply, and each check runs on its own, so one that cannot be made does not stop the rest.</p>
          }
          @if (!s.results() && !s.applying() && offer().length; as n) {
            <div class="offer">
              <p>Rebuilding the library changes what {{ n }} {{ n === 1 ? 'agent reads' : 'agents read' }}. Check {{ n === 1 ? 'it' : 'them' }} afterwards?</p>
              <button type="button" class="quiet tiny" (click)="s.verifyMany(offer())">Add {{ n === 1 ? '1 check' : n + ' checks' }} to this list</button>
            </div>
          }
          @if (s.results(); as results) {
            <ol class="steps">
              @for (r of results; track $index) {
                <li [class]="'step result ' + r.status">
                  <h3>{{ r.title }} <span class="status">{{ status[r.status] }}</span></h3>
                  @if (r.message) { <p class="message">{{ r.message }}</p> }
                  @if (r.status === 'applied') {
                    <ul class="lines">@for (l of r.lines; track $index) { <li [class]="l.tone"><span class="sr">{{ tone[l.tone] }}: </span>{{ l.text }}</li> }</ul>
                  }
                </li>
              }
            </ol>
          } @else {
            <ol class="steps">
              @for (item of s.tray(); track item.uid) {
                <li class="step" [class.blocked]="!s.itemReady(item) && !!(item.preview || item.error)">
                  <h3>{{ item.preview?.title || 'Checking…' }}</h3>
                  @if (item.error) { <p class="message fault">{{ item.error }}</p> }
                  @if (item.preview; as p) {
                    @if (item.deferred && item.change.kind === 'library.rebuild') {
                      <p class="deferred">Rebuilds the library with the changes above, so your wired projects get them. The exact list appears in the result.</p>
                    } @else {
                      @if (item.deferred) { <p class="deferred">Checked again after the steps above run, so the details may change.</p> }
                      <ul class="lines">@for (l of p.lines; track $index) { <li [class]="l.tone"><span class="sr">{{ tone[l.tone] }}: </span>{{ l.text }}</li> }</ul>
                    }
                    @if (!s.itemReady(item)) { @for (c of p.conflicts; track $index) { <p class="message fault">{{ c }}</p> } }
                  }
                  <button type="button" class="quiet tiny" (click)="s.remove(item.uid)" [disabled]="s.applying()">Remove</button>
                </li>
              }
            </ol>
            <p class="fine">Changes run in this order, one at a time. Each one is checked against your folders again just before it runs. If one cannot be made, the ones after it are not run. The exception is a fetch or a check: one of those that fails never stops the others.</p>
          }
        </div>
      }
    </aside>
  }
` })
export class Tray {
  s = inject(Store);
  tone = TONE_LABEL;
  status = STATUS_LABEL;
  count(n: number) { return n === 1 ? '1 change' : `${n} changes`; }
  /** Checks waiting in the sheet, for the note about what they ask. */
  checks = computed(() => this.s.tray().filter(i => i.change.kind === 'project.verify').length);
  /**
   * A rebuild changes what every agent reading the library through a link sees, so offer to check those afterwards.
   * Only offered while a rebuild is waiting; checks already in the sheet are not offered twice.
   */
  offer = computed(() => {
    const c = this.s.catalog();
    if (!c || !this.s.tray().some(i => i.change.kind === 'library.rebuild')) return [];
    return pendingChecks(c.projects, i => this.s.pendingFor('project.verify', a => a['projectId'] === i.projectId && a['target'] === i.target).length > 0, t => t.feeds === 'library');
  });
  heading = computed(() => {
    const results = this.s.results();
    if (results) {
      const applied = results.filter(r => r.status === 'applied').length;
      return applied === results.length ? `Applied ${this.count(applied)}` : `${applied} of ${results.length} applied`;
    }
    const progress = this.s.applyProgress();
    if (this.s.applying()) return progress ? `Applying: ${progress.done} of ${progress.total} done` : 'Applying your changes';
    if (this.s.checking()) return 'Checking your changes';
    const n = this.s.tray().length;
    return this.s.blocked() ? `${this.count(n)}, one needs attention` : `${this.count(n)} ready to review`;
  });
}
