import { Component, computed, inject, signal } from '@angular/core';
import { Router } from '@angular/router';
import { Store } from './store';

@Component({ selector: 'af-sources', template: `
  <h1>Manage skill sources</h1><p class="lead">See where skills come from and inspect their local state.</p>
  @if(s.catalog(); as c){
    <section class="vault-strip" aria-label="Primary vault"><div><span class="caption">Primary vault</span><strong>{{c.sources[0].root}}</strong></div><span>{{c.sources[0].count ?? 'Unknown'}} skills · {{c.sources[0].state}}</span><button (click)="select(c.sources[0].id)">Inspect vault</button></section>
    <div class="workbench" [class.detail-open]="detail()"><section class="panel list-panel"><h2>Registered sources</h2><label for="source-search">Search sources</label><input id="source-search" type="search" placeholder="Name or location" [value]="s.sourceQuery()" (input)="s.sourceQuery.set($any($event.target).value)">
      <div class="table-scroll"><table><thead><tr><th>Source</th><th>Skills</th><th>Local state</th></tr></thead><tbody>
      @for(source of filtered(); track source.id){<tr [class.selected]="source.id === s.sourceId()"><td><button class="row-button" [attr.data-source]="source.id" (click)="select(source.id)">{{source.name}}</button><small>{{source.kind}} / {{source.location}}</small></td><td>{{source.count ?? 'Unknown'}}</td><td>{{source.state}}<small>{{source.revision ? 'Revision ' + source.revision : 'Revision unavailable'}}</small></td></tr>}
      </tbody></table></div>
      @if(!filtered().length){<p class="empty">{{c.sources.length === 1 ? 'No external sources are registered. Your primary vault is available above.' : 'No sources match this search.'}}</p>}
    </section><aside class="panel inspector" aria-label="Source inspector"><button class="back" (click)="back()">Back to sources</button>
      @if(s.selectedSource(); as source){<h2>{{source.name}}</h2><p class="muted">{{source.kind}} source / {{source.state}}</p><dl><dt>Location</dt><dd>{{source.location}}</dd><dt>Local folder</dt><dd>{{source.root}}</dd><dt>Local revision</dt><dd>{{source.revision || 'Not available'}}</dd><dt>Discovered skills</dt><dd>{{source.count ?? 'Unknown'}}</dd></dl>
      @if(source.error){<p class="notice error">{{source.error}}</p>}
      <button class="primary" (click)="viewSkills(source.id)">View skills</button>
      <p class="notice">Merged skills link to source folders. An external fetch can change content already in use.</p>
      @if(source.rejectionCount){<h3>Rejected entries ({{source.rejectionCount}})</h3>@for(r of c.rejected; track $index){@if(r.sourceId === source.id){<p class="rejection">{{r.path}}<small>{{r.reason}}</small></p>}}}
      } @else {<h2>Source details</h2><p class="empty">Select a source to inspect its provenance and discovered skills.</p>}
    </aside></div>
  } @else if(!s.busy()){<p class="empty">Refresh local data to inspect sources.</p>}
` })
export class Sources {
  s = inject(Store); private router = inject(Router); detail = signal(!!this.s.sourceId());
  filtered = computed(() => { const q = this.s.sourceQuery().toLowerCase(); return this.s.catalog()?.sources.filter(x => x.kind !== 'primary' && `${x.name} ${x.location}`.toLowerCase().includes(q)) || []; });
  select(id: string) { this.s.sourceId.set(id); this.detail.set(true); }
  back() { this.detail.set(false); setTimeout(() => document.querySelector<HTMLButtonElement>(`[data-source="${this.s.sourceId()}"]`)?.focus()); }
  viewSkills(id: string) { this.s.sourceFilter.set(id); this.s.skillId.set(''); this.s.view.set('all'); this.s.page.set(0); void this.router.navigateByUrl('/skills'); }
}
