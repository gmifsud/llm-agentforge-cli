import { Component, inject, signal } from '@angular/core';
import { DatePipe } from '@angular/common';
import { Router } from '@angular/router';
import { Store } from './store';

@Component({ selector: 'af-skills', imports: [DatePipe], template: `
  <h1>Inspect your skill library</h1><p class="lead">Trace instructions to their source and see which version wins when names overlap.</p>
  @if(s.catalog(); as c){
    <div class="view-options" role="group" aria-label="Skill view"><button [attr.aria-pressed]="s.view() === 'all'" (click)="view('all')">All discovered</button><button [attr.aria-pressed]="s.view() === 'merged'" (click)="view('merged')" [disabled]="!c.mergeAvailable">Merged preview</button><button [attr.aria-pressed]="s.view() === 'collisions'" (click)="view('collisions')" [disabled]="!c.mergeAvailable">Name collisions ({{c.collisions.length}})</button><span>Computed locally / not applied</span></div>
    <div class="workbench" [class.detail-open]="detail()"><section class="panel list-panel"><label for="skill-search">Search skills</label><input id="skill-search" type="search" placeholder="Name, path or source" [value]="s.skillQuery()" (input)="s.skillQuery.set($any($event.target).value); s.page.set(0)">
    <div class="filter-row"><label for="source-filter">Source</label><select id="source-filter" (change)="s.sourceFilter.set($any($event.target).value); s.page.set(0)"><option value="" [selected]="!s.sourceFilter()">All sources</option>@for(source of c.sources; track source.id){<option [value]="source.id" [selected]="source.id === s.sourceFilter()">{{source.name}}</option>}</select><span role="status">{{s.filteredSkills().length}} {{s.filteredSkills().length === 1 ? 'skill' : 'skills'}}</span></div>
    <div class="table-scroll"><table><thead><tr><th>Skill</th><th>Source</th><th>Merge outcome</th></tr></thead><tbody>
    @for(skill of s.visibleSkills(); track skill.id){<tr [class.selected]="skill.id === s.skillId()"><td><button class="row-button" [attr.data-skill]="skill.id" (click)="select(skill.id)">{{skill.name}}</button><small>{{skill.relativePath}}</small></td><td>{{s.sourceName(skill.sourceId)}}</td><td>{{!c.mergeAvailable ? 'Unavailable' : c.winnerIds.includes(skill.id) ? 'Selected' : 'Excluded'}}@if(s.collision(skill.id)){<small>Name collision</small>}</td></tr>}
    </tbody></table></div>@if(!s.visibleSkills().length){<p class="empty">No skills match this view. Change the search or source filter.</p>}
    <div class="pagination"><button (click)="s.page.set(s.page()-1)" [disabled]="s.page() === 0">Previous</button><span>Page {{s.page()+1}} of {{s.pages()}}</span><button (click)="s.page.set(s.page()+1)" [disabled]="s.page()+1 >= s.pages()">Next</button></div>
    <p class="muted">The shared library is linked as a whole. This view does not enable or disable individual skills.</p>
    </section><aside class="panel inspector" aria-label="Skill inspector"><button class="back" (click)="back()">Back to skills</button>
    @if(s.selectedSkill(); as skill){<h2>{{skill.name}}</h2><p class="muted">{{s.sourceName(skill.sourceId)}}</p><p class="path">{{skill.relativePath}} / SKILL.md</p>
      @if(s.collision(skill.id); as collision){<section class="notice"><h3>Name collision</h3>@for(id of collision.candidateIds; track id){<p>{{id === collision.winnerId ? 'Kept' : 'Excluded'}}: {{sourceForSkill(id)}}</p>}<small>Default merge rules / not applied</small></section>}
      <button class="primary" (click)="s.readDocument(skill.id)" [disabled]="s.reading() || s.stale()">{{s.documentBusy() ? 'Reading…' : 'Read full SKILL.md'}}</button>
      @if(s.documentError()){<p class="notice error" role="alert">{{s.documentError()}}</p>}
      @if(s.document(); as doc){<p class="caption">Read {{doc.readAt | date:'mediumTime'}} / plain text</p><pre class="document" tabindex="0" aria-label="Skill document">{{doc.text}}</pre>}
      <button (click)="openSource(skill.sourceId)">Open source details</button>
    } @else {<h2>Skill details</h2><p class="empty">Select a skill to inspect its source and instructions.</p>}
    </aside></div>
  }
` })
export class Skills {
  s = inject(Store); private router = inject(Router); detail = signal(!!this.s.skillId());
  view(value: 'all'|'merged'|'collisions') { this.s.view.set(value); this.s.page.set(0); }
  select(id: string) { this.s.selectSkill(id); this.detail.set(true); }
  back() { this.detail.set(false); setTimeout(() => document.querySelector<HTMLButtonElement>(`[data-skill="${this.s.skillId()}"]`)?.focus()); }
  sourceForSkill(id: string) { const skill = this.s.catalog()?.skills.find(x => x.id === id); return skill ? `${this.s.sourceName(skill.sourceId)} / ${skill.relativePath}` : 'Unknown'; }
  openSource(id: string) { this.s.sourceId.set(id); void this.router.navigateByUrl('/sources'); }
}
