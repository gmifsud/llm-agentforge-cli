import { Component, computed, inject, input } from '@angular/core';
import { Store, type KeptIssue } from './store';

/** "obra-superpowers'" or "Your vault's": a source name made possessive. */
function owner(name: string) { return name.endsWith('s') && name !== 'Your vault' ? `${name}'` : `${name}'s`; }

/** What is wrong with a kept copy, in the words the Need a look view uses. */
export function keptIssueLine(issue: KeptIssue, s: Store): string {
  const source = issue.fromSourceId ? s.sourceName(issue.fromSourceId) : '';
  const original = source ? `${owner(source)} ${issue.fromSkill}` : `the original ${issue.fromSkill}`;
  if (issue.kind === 'stale') return `${issue.name} was written for an older version of ${original}.`;
  if (issue.kind === 'missing') return `${source || 'That source'} no longer has ${issue.fromSkill}; the copy is not in the library.`;
  if (issue.kind === 'taken') {
    const other = (s.catalog()?.skills || []).find(x => !x.kept && x.name.toLowerCase() === issue.name.toLowerCase());
    return `${issue.name} is now also a skill in ${other ? s.sourceName(other.sourceId) : 'a source'}, so the copy is not in the library.`;
  }
  return `${issue.name} is not in the library: ${original} now keeps the plain name ${issue.fromSkill}.`;
}

/** One kept copy that needs a look, with what a person can do about it. */
@Component({ selector: 'af-kept-issue', template: `
  <article class="kept-issue" [attr.aria-label]="'Kept copy: ' + issue().name">
    <p><strong class="path">{{ issue().name }}</strong> <span class="fine">{{ line() }}</span></p>
    @if (planned()) { <p class="planned-note">Will change when you apply</p> }
    @if (issue().kind === 'stale') {
      @if (suggestion(); as sg) {
        <p class="fine">Suggested description ({{ sg.by === 'fallback' ? 'fallback suggestion' : 'suggested by Claude' }}): {{ sg.description }}</p>
        <div class="actions"><button type="button" class="quiet tiny" (click)="s.rekeep(issue().name, sg.description)" [disabled]="locked() || !!s.descriptionProblem(sg.description)">Use this description</button></div>
      }
      @if (error()) { <p class="field-error" role="alert">Could not suggest: {{ error() }}</p> }
    }
    <div class="actions">
      @switch (issue().kind) {
        @case ('stale') {
          <button type="button" class="quiet tiny" (click)="suggestAgain()" [disabled]="locked() || suggesting()" [attr.aria-label]="'Suggest a new description for ' + issue().name">{{ suggesting() ? 'Suggesting…' : 'Suggest again' }}</button>
          <button type="button" class="quiet tiny" (click)="s.rekeep(issue().name)" [disabled]="locked()" [attr.aria-label]="'Keep the description of ' + issue().name">Keep the description</button>
          <button type="button" class="quiet tiny" (click)="s.unkeep(issue().name)" [disabled]="locked()" [attr.aria-label]="'Remove the copy ' + issue().name">Remove the copy</button>
        }
        @case ('missing') {
          <button type="button" class="quiet tiny" (click)="s.unkeep(issue().name)" [disabled]="locked()" [attr.aria-label]="'Remove the rule for ' + issue().name">Remove the rule</button>
        }
        @default {
          <button type="button" class="quiet tiny" (click)="s.renameKept(issue().fromSkill)" [disabled]="s.applying()" [attr.aria-label]="'Rename ' + issue().name">Rename</button>
        }
      }
    </div>
  </article>
` })
export class KeptIssueRow {
  s = inject(Store);
  issue = input.required<KeptIssue>();
  line = computed(() => keptIssueLine(this.issue(), this.s));
  locked = computed(() => this.s.changesLocked() || this.planned());
  planned = computed(() => this.s.pendingFor('library.rekeep', a => a['name'] === this.issue().name).length + this.s.pendingFor('library.unkeep', a => a['name'] === this.issue().name).length > 0);
  private sourceKey = computed(() => (this.issue().fromSourceId ? this.s.sourceById(this.issue().fromSourceId!)?.key : null) ?? null);
  suggestion = computed(() => { const key = this.sourceKey(); return key ? this.s.suggestions().get(this.issue().fromSkill)?.find(x => x.source === key) || null : null; });
  suggesting = computed(() => this.s.suggesting().has(this.issue().fromSkill));
  error = computed(() => this.s.suggestErrors().get(this.issue().fromSkill) || '');
  suggestAgain() { void this.s.suggestOne(this.issue().fromSkill, true); }
}
