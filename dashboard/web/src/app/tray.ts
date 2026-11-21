import { Component, ElementRef, OnDestroy, afterRenderEffect, computed, effect, inject, signal, viewChild } from '@angular/core';
import { Store } from './store';
import { pendingChecks } from './project-status';

const TONE_LABEL: Record<string, string> = { add: 'Adds', remove: 'Removes', change: 'Changes', note: 'Note', warn: 'Check' };
const STATUS_LABEL: Record<string, string> = { applied: 'Applied', refused: 'Refused', failed: 'Failed', skipped: 'Not run', uncertain: 'Outcome unknown' };
const CLOCK_INTERVAL_MS = 1000;

@Component({ selector: 'af-tray', templateUrl: './tray.html' })
export class Tray implements OnDestroy {
  s = inject(Store);
  tone = TONE_LABEL;
  status = STATUS_LABEL;
  private review = viewChild.required<ElementRef<HTMLDialogElement>>('review');
  private opener: HTMLElement | null = null;
  private clock = signal(Date.now());
  count(n: number) { return n === 1 ? '1 change' : `${n} changes`; }
  rows = computed(() => this.s.runSteps().length ? this.s.runSteps() : this.s.tray().map(item => ({ item, startedAt: null, result: null })));
  checks = computed(() => this.s.tray().filter(i => i.change.kind === 'project.verify').length);
  operations = computed(() => this.s.tray().length - this.checks());
  offer = computed(() => {
    const c = this.s.catalog();
    if (!c || !this.s.tray().some(i => i.change.kind === 'library.rebuild')) return [];
    return pendingChecks(c.projects, i => this.s.pendingFor('project.verify', a => a['projectId'] === i.projectId && a['target'] === i.target).length > 0, t => t.feeds === 'library' || t.feeds === 'set');
  });
  heading = computed(() => {
    const results = this.s.results();
    if (results) {
      const applied = results.filter(r => r.status === 'applied').length;
      const uncertain = results.filter(r => r.status === 'uncertain').length;
      if (uncertain) return `${applied} confirmed applied; ${uncertain} ${uncertain === 1 ? 'outcome' : 'outcomes'} unknown`;
      return applied === results.length ? `Applied ${this.count(applied)}` : `${results.length} finished · ${applied} applied · ${results.length - applied} need attention`;
    }
    const progress = this.s.applyProgress();
    if (this.s.applying()) return progress ? `Applying: ${progress.done} of ${progress.total} done` : 'Applying your changes';
    if (this.s.checking()) return 'Checking your changes';
    const n = this.s.tray().length;
    if (!n) return 'No changes queued';
    return this.s.blocked() ? `${this.count(n)}, one needs attention` : `${this.count(n)} ready to review`;
  });
  announcement = computed(() => {
    const index = this.s.activeStep();
    const active = index === null ? null : this.s.runSteps()[index];
    return active ? `${this.heading()}. Running: ${active.item.preview?.title || active.item.change.kind}` : this.heading();
  });

  private beforeUnload = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ''; };
  constructor() {
    afterRenderEffect(() => {
      const dialog = this.review().nativeElement;
      if (this.s.trayOpen() && !dialog.open) {
        this.opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
        dialog.showModal();
        dialog.querySelector<HTMLElement>('#review-title')?.focus();
      } else if (!this.s.trayOpen() && dialog.open) {
        dialog.close();
        const back = this.opener?.isConnected ? this.opener : document.getElementById('changes-control');
        back?.focus();
        this.opener = null;
      }
    });
    effect(onCleanup => {
      if (!this.s.applying()) return;
      this.clock.set(Date.now());
      const timer = setInterval(() => this.clock.set(Date.now()), CLOCK_INTERVAL_MS);
      window.addEventListener('beforeunload', this.beforeUnload);
      onCleanup(() => { clearInterval(timer); window.removeEventListener('beforeunload', this.beforeUnload); });
    });
  }
  open() { this.s.trayOpen.set(true); }
  close(event?: Event) { event?.preventDefault(); this.s.trayOpen.set(false); }
  collapse() { this.s.setTrayHidden(false); }
  hide() { this.s.setTrayHidden(true); }
  trapFocus(event: KeyboardEvent) {
    if (event.key !== 'Tab') return;
    const controls = Array.from(this.review().nativeElement.querySelectorAll<HTMLElement>('button:not(:disabled), a[href], input:not(:disabled), select:not(:disabled), textarea:not(:disabled), summary, [tabindex="0"]'))
      .filter(element => element.tabIndex >= 0 && element.getClientRects().length > 0);
    const target = event.shiftKey ? controls.at(-1) : controls[0];
    const boundary = event.shiftKey ? controls[0] : controls.at(-1);
    if (target && document.activeElement === boundary) { event.preventDefault(); target.focus(); }
  }
  // A delayed native close event must not close a newly reopened dialog.
  closed() { if (!this.review().nativeElement.open) this.s.trayOpen.set(false); }
  elapsed(started: number | null) {
    const seconds = Math.max(0, Math.floor((this.clock() - (started ?? this.clock())) / 1000));
    return seconds < 60 ? `${seconds}s elapsed` : `${Math.floor(seconds / 60)}m ${seconds % 60}s elapsed`;
  }
  ngOnDestroy() { window.removeEventListener('beforeunload', this.beforeUnload); }
}
