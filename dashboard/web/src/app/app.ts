import { Component, inject, OnInit, computed } from '@angular/core';
import { DatePipe } from '@angular/common';
import { RouterLink, RouterLinkActive, RouterOutlet } from '@angular/router';
import { Store } from './store';
import { Tray } from './tray';

@Component({ selector: 'af-root', imports: [RouterLink, RouterLinkActive, RouterOutlet, DatePipe, Tray], template: `
  <a class="skip-link" href="#main">Skip to content</a>
  <header class="masthead">
    <a routerLink="/" class="wordmark">agentforge</a>
    <nav aria-label="Pages">
      <a routerLink="/" routerLinkActive="active" [routerLinkActiveOptions]="{ exact: true }" ariaCurrentWhenActive="page">Fleet</a>
      <a routerLink="/sets" routerLinkActive="active" ariaCurrentWhenActive="page">Sets</a>
      <a routerLink="/library" routerLinkActive="active" ariaCurrentWhenActive="page">Skills</a>
    </nav>
    <p class="observed" role="status">
      @if (s.busy()) { Reading your folders… }
      @else if (s.catalog(); as c) { Checked at {{ c.completedAt | date:'shortTime' }} }
    </p>
    <button type="button" class="quiet" (click)="s.refresh()" [disabled]="s.busy() || s.applying()">Refresh</button>
  </header>
  <main id="main" tabindex="-1" [class.with-tray]="s.tray().length || s.results()" [class.tray-open]="s.trayOpen()">
    @if (s.error()) {
      <div class="notice fault" role="alert">{{ s.error() }} @if (s.catalog()) { <strong>What you see may be out of date.</strong> }</div>
    }
    @if (warnings().length) {
      <ul class="notices">@for (w of warnings(); track $index) { <li class="notice">{{ w }}</li> }</ul>
    }
    <router-outlet />
  </main>
  <af-tray />
` })
export class App implements OnInit {
  s = inject(Store);
  /** Library and source warnings that are already shown on the board are not repeated here. */
  warnings = computed(() => (this.s.catalog()?.warnings || []).filter(w => !/^Merge preview unavailable|^Local revision unavailable/.test(w)));
  ngOnInit() { void this.s.start(); }
}
