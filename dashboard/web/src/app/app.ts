import { Component, inject, OnInit } from '@angular/core';
import { DatePipe } from '@angular/common';
import { RouterLink, RouterLinkActive, RouterOutlet } from '@angular/router';
import { Store } from './store';

@Component({ selector: 'af-root', imports: [RouterLink, RouterLinkActive, RouterOutlet, DatePipe], template: `
  <a class="skip-link" href="#main">Skip to content</a>
  <header class="topbar"><a routerLink="/sources" class="brand">agentforge</a><span>Skill workspace</span><span class="mode">Local / read-only</span></header>
  <div class="shell"><nav aria-label="Workspace"><a routerLink="/sources" routerLinkActive="active" ariaCurrentWhenActive="page">Sources</a><a routerLink="/skills" routerLinkActive="active" ariaCurrentWhenActive="page">Skills</a><a routerLink="/projects" routerLinkActive="active" ariaCurrentWhenActive="page">Projects</a><p class="nav-note">Inspect local files.<br>No changes applied.</p></nav>
  <main id="main" tabindex="-1"><div class="refresh-bar"><span role="status">@if(s.busy()){Reading local folders…} @else if(s.catalog(); as c){Observed {{c.completedAt | date:'mediumTime'}} · {{c.status}} } @else {No local observation yet}</span><button (click)="s.refresh()" [disabled]="s.busy() || s.documentBusy() || s.projectBusy()">Refresh local data</button></div>
    @if(s.error()){<div class="notice error" role="alert">{{s.error()}} @if(s.catalog()){<strong>Showing stale data. Document reads are paused until refresh succeeds.</strong>}</div>}
    @for(warning of s.catalog()?.warnings || []; track $index){<p class="notice">{{warning}}</p>}
    <router-outlet />
  </main></div><footer>Agent Forge M1 <span>Local observations are not pinned revisions or runtime compatibility checks.</span></footer>
` })
export class App implements OnInit { s = inject(Store); ngOnInit() { void this.s.start(); } }
