import { Component, inject, signal } from '@angular/core';
import { DatePipe } from '@angular/common';
import { RouterLink } from '@angular/router';
import { Store, type Shadow, type SkillView } from './store';
import { differenceText } from './skill-actions';
import { SetAsideList } from './set-aside-list';

const TOOL: Record<string, string> = { claude: 'Claude Code', codex: 'Codex', gemini: 'Gemini CLI', cursor: 'Cursor' };

@Component({ selector: 'af-library', imports: [DatePipe, RouterLink, SetAsideList], template: `
  <header class="page-head">
    <h1>Skill library</h1>
    <p>Every skill found in your vault and attached repositories, and why each one is or is not what your agents get.</p>
  </header>
  @if (s.catalog(); as c) {
    <div class="filters">
      <div class="field grow">
        <label for="skill-search">Search</label>
        <input id="skill-search" type="search" placeholder="Name, folder or source" [value]="s.skillQuery()" (input)="s.skillQuery.set($any($event.target).value); s.page.set(0)">
      </div>
      <div class="field">
        <label for="source-filter">Source</label>
        <select id="source-filter" (change)="s.sourceFilter.set($any($event.target).value); s.page.set(0)">
          <option value="" [selected]="!s.sourceFilter()">All sources</option>
          @for (source of c.sources; track source.id) { <option [value]="source.id" [selected]="source.id === s.sourceFilter()">{{ s.sourceName(source.id) }}</option> }
        </select>
      </div>
      <div class="segmented" role="group" aria-label="Show">
        <button type="button" [attr.aria-pressed]="s.view() === 'all'" (click)="view('all')">Everything found</button>
        <button type="button" [attr.aria-pressed]="s.view() === 'merged'" (click)="view('merged')" [disabled]="!c.mergeAvailable">In the library</button>
        <button type="button" [attr.aria-pressed]="s.view() === 'collisions'" (click)="view('collisions')" [disabled]="!c.mergeAvailable">Name clashes ({{ c.collisions.length }})</button>
        <button type="button" [attr.aria-pressed]="s.view() === 'attention'" (click)="view('attention')" [disabled]="!c.mergeAvailable">Need a look ({{ s.attention().length }})</button>
        <button type="button" [attr.aria-pressed]="s.view() === 'problems'" (click)="view('problems')" [disabled]="!c.health">Have problems ({{ problemCount() }})</button>
      </div>
    </div>

    <div class="split" [class.detail-open]="detail()">
      <section class="list" aria-label="Skills">
        <p class="count" role="status">{{ s.filteredSkills().length }} {{ s.filteredSkills().length === 1 ? 'skill' : 'skills' }}</p>
        <table>
          <thead><tr><th scope="col">Skill</th><th scope="col">Source</th><th scope="col">What your agents get</th></tr></thead>
          <tbody>
            @for (skill of s.visibleSkills(); track skill.id) {
              <tr [class.selected]="skill.id === s.skillId()">
                <td><button type="button" class="row-button" [attr.data-skill]="skill.id" (click)="select(skill.id)">{{ skill.name }}</button>
                  @if (s.findingsFor(skill.id).length || s.shadowsFor(skill.id).length) { <span class="tag runs">has a problem</span> }</td>
                <td>{{ s.sourceName(skill.sourceId) }}</td>
                <td [class.muted]="!c.winnerIds.includes(skill.id)">{{ s.reason(skill) }}</td>
              </tr>
            }
          </tbody>
        </table>
        @if (!s.visibleSkills().length) { <p class="empty">Nothing matches. Clear the search or choose another view.</p> }
        @if (s.pages() > 1) {
          <nav class="pager" aria-label="Pages">
            <button type="button" class="quiet" (click)="s.page.set(s.page() - 1)" [disabled]="s.page() === 0">Previous</button>
            <span>Page {{ s.page() + 1 }} of {{ s.pages() }}</span>
            <button type="button" class="quiet" (click)="s.page.set(s.page() + 1)" [disabled]="s.page() + 1 >= s.pages()">Next</button>
          </nav>
        }
        @if (c.rejected.length) {
          <details class="skipped"><summary>{{ c.rejected.length }} {{ c.rejected.length === 1 ? 'folder was' : 'folders were' }} skipped while looking for skills</summary>
            <ul>@for (r of c.rejected; track $index) { <li><span class="path">{{ r.path }}</span> {{ r.reason }} <span class="muted">in {{ s.sourceName(r.sourceId) }}</span></li> }</ul>
          </details>
        }
      </section>

      <aside class="inspector" aria-label="Skill details">
        <button type="button" class="quiet back" (click)="back()">Back to the list</button>
        @if (s.selectedSkill(); as skill) {
          <h2>{{ skill.name }}</h2>
          <p class="muted">From {{ s.sourceName(skill.sourceId) }}. {{ s.reason(skill) }}.</p>
          <p class="path">{{ slash(skill.relativePath) }}/SKILL.md</p>
          @if (s.collision(skill.id); as col) {
            <p>{{ col.candidateIds.length }} sources have a skill called {{ col.name }}.
              <a class="button quiet tiny" [routerLink]="['/compare', col.name]">Compare the copies</a></p>
          }
          @if (s.findingsFor(skill.id).length || s.shadowsFor(skill.id).length) {
            <section class="findings" aria-label="Problems">
              <h3>Problems</h3>
              <ul>
                @for (f of s.findingsFor(skill.id); track f.code) {
                  <li [class]="f.severity"><strong>{{ tools(f.tools) }}:</strong> {{ plain(f.message, skill.name) }}</li>
                }
                @for (sh of s.shadowsFor(skill.id); track sh.path) {
                  <li class="warn">
                    <strong>{{ toolName(sh.tool) }}:</strong> your own skill has the same name and is used instead of this one.
                    <dl class="shadow-paths">
                      <dt>Yours</dt><dd class="path">{{ sh.path }}</dd>
                      @if (sh.libraryPath) { <dt>Library</dt><dd class="path">{{ sh.libraryPath }}</dd> }
                    </dl>
                    <p class="fine">{{ difference(sh) }}</p>
                    @if (plannedAside(sh)) { <span class="planned-note">Will be set aside when you apply</span> }
                    @else {
                      <button type="button" class="quiet tiny" (click)="s.setAside(sh.tool, sh.name)" [disabled]="s.applying()"
                              [attr.aria-label]="'Set aside your ' + sh.name + ' for ' + toolName(sh.tool)">Set aside my copy</button>
                      <span class="fine">Moves it whole to ~/.agentforge/set-aside. Nothing is deleted, and Restore puts it back.</span>
                    }
                  </li>
                }
              </ul>
            </section>
          }
          <button type="button" class="primary" (click)="s.readDocument(skill.id)" [disabled]="s.reading() || s.stale()">{{ s.documentBusy() ? 'Opening…' : 'Read SKILL.md' }}</button>
          @if (s.documentError()) { <p class="notice fault" role="alert">{{ s.documentError() }}</p> }
          @if (s.document(); as doc) {
            <p class="fine">Read at {{ doc.readAt | date:'mediumTime' }}, shown as plain text.</p>
            <pre class="document" tabindex="0" aria-label="SKILL.md contents">{{ doc.text }}</pre>
          }
        } @else {
          <p class="empty">Choose a skill to see where it comes from and read its instructions.</p>
        }
      </aside>
    </div>
    <af-set-aside />
  }
` })
export class Library {
  s = inject(Store);
  detail = signal(!!this.s.skillId());
  view(value: SkillView) { this.s.view.set(value); this.s.page.set(0); }
  select(id: string) { this.s.selectSkill(id); this.detail.set(true); }
  back() { this.detail.set(false); setTimeout(() => document.querySelector<HTMLButtonElement>(`[data-skill="${this.s.skillId()}"]`)?.focus()); }
  slash(p: string) { return p.split('\\').join('/'); }
  problemCount() { const h = this.s.catalog()?.health; return h ? new Set([...h.findings.filter(f => f.severity !== 'info').map(f => f.skillId), ...h.shadows.map(x => x.skillId)]).size : 0; }
  toolName(t: string) { return TOOL[t] || t; }
  difference = differenceText;
  plannedAside(sh: Shadow) { return this.s.pendingFor('skill.setaside', a => a['tool'] === sh.tool && a['name'] === sh.name).length > 0; }
  tools(list: string[]) { return list.map(t => this.toolName(t)).join(', '); }
  /** The message starts with the folder name, which the heading already shows. */
  plain(message: string, name: string) { const text = message.replace(new RegExp(`^[^:]*: `), ''); return text.charAt(0).toUpperCase() + text.slice(1); }
}
