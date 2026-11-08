import { Component, inject } from '@angular/core';
import { DatePipe } from '@angular/common';
import { Store } from './store';

@Component({ selector: 'af-projects', imports: [DatePipe], template: `
  <h1>Inspect project connections</h1><p class="lead">Check documents and skill folders for the projects selected when this session started.</p>
  <section class="panel"><label for="project-select">Project</label><div class="filter-row"><select id="project-select" (change)="s.selectProject($any($event.target).value)"><option value="" [selected]="!s.projectId()">Choose a configured project</option>@for(p of s.context()?.projects || []; track p.id){<option [value]="p.id" [selected]="p.id === s.projectId()">{{p.name}} / {{p.path}}</option>}</select><button class="primary" (click)="s.inspectProject(s.projectId())" [disabled]="!s.projectId() || s.reading()">{{s.projectBusy() ? 'Inspecting…' : 'Inspect project'}}</button></div><p class="muted">To inspect another folder, restart with an additional --project path.</p></section>
  @if(s.projectError()){<p class="notice error" role="alert">{{s.projectError()}}</p>}
  @if(s.project(); as report){<section class="panel project-report"><h2>{{report.project.name}}</h2><p class="path">{{report.project.path}}</p><p class="caption">Observed {{report.readAt | date:'medium'}} / {{report.state}}</p><dl><dt>Effective skill library</dt><dd>{{report.deployment.root}}</dd><dt>Resolution origin</dt><dd>{{report.deployment.origin}}</dd></dl>
  @for(w of report.warnings.concat(report.deployment.warnings); track $index){<p class="notice">{{w}}</p>}
  <div class="table-scroll"><table><thead><tr><th>Target</th><th>Instruction document</th><th>Skills folder</th><th>Library match</th></tr></thead><tbody>@for(target of report.targets; track target.id){<tr><td><strong>{{target.id}}</strong></td><td>{{target.doc}}<small>{{target.docExists ? 'Present' : 'Missing'}}</small></td><td>{{target.health}}<small>{{target.resolvedTarget || 'No resolved link target'}}</small></td><td>{{target.match}}</td></tr>}</tbody></table></div><p class="muted">A healthy link can point to a different library. Folder presence does not prove an agent can invoke its skills.</p></section>}
` })
export class Projects { s = inject(Store); }
