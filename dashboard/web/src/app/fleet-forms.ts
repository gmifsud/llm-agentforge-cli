import { Component, computed, inject, output, signal } from '@angular/core';
import { Store } from './store';
import { isGitLocation, suggestName } from './source-status';

/** Attach a folder or Git repository of skills. Submitting queues the change; the review sheet shows what it will do. */
@Component({ selector: 'af-attach-form', template: `
  <form (submit)="submit($event)" aria-labelledby="drawer-title">
    <h2 id="drawer-title" tabindex="-1">Attach a repository</h2>
    <label for="attach-location">Folder path or Git URL</label>
    <input id="attach-location" autocomplete="off" spellcheck="false" placeholder="D:\\Repos\\LLM\\my-skills"
           [value]="location()" (input)="location.set($any($event.target).value)" required>
    <label for="attach-name">Name <span class="optional">optional</span></label>
    <input id="attach-name" autocomplete="off" spellcheck="false" [placeholder]="suggested() || 'my-skills'"
           [value]="name()" (input)="name.set($any($event.target).value)">
    @if (isGit()) {
      <label for="attach-branch">Branch <span class="optional">optional, the default branch is used otherwise</span></label>
      <input id="attach-branch" autocomplete="off" spellcheck="false" [value]="branch()" (input)="branch.set($any($event.target).value)">
    }
    <p class="fine">{{ isGit() ? 'It is downloaded, then the library is rebuilt to include it.' : 'The folder is read in place, then the library is rebuilt to include it.' }}</p>
    <div class="actions">
      <button type="submit" class="primary" [disabled]="!location().trim()">Attach</button>
      <button type="button" class="quiet" (click)="done.emit()">Cancel</button>
    </div>
  </form>
` })
export class AttachForm {
  private s = inject(Store);
  done = output<void>();
  location = signal(''); name = signal(''); branch = signal('');
  isGit = computed(() => isGitLocation(this.location()));
  suggested = computed(() => suggestName(this.location()));
  submit(event: Event) {
    event.preventDefault();
    const location = this.location().trim(); if (!location) return;
    this.s.attach(location, this.name().trim(), this.branch().trim());
    this.done.emit();
  }
}

/** Add the folder of a repository you work in. Nothing in it changes until you wire it. */
@Component({ selector: 'af-project-form', template: `
  <form (submit)="submit($event)" aria-labelledby="drawer-title">
    <h2 id="drawer-title" tabindex="-1">Add a project</h2>
    <label for="project-path">Project folder</label>
    <input id="project-path" autocomplete="off" spellcheck="false" placeholder="D:\\Repos\\my-app"
           [value]="path()" (input)="path.set($any($event.target).value)" required>
    <p class="fine">Nothing in the folder changes until you wire it.</p>
    <div class="actions">
      <button type="submit" class="primary" [disabled]="!path().trim()">Add</button>
      <button type="button" class="quiet" (click)="done.emit()">Cancel</button>
    </div>
  </form>
` })
export class ProjectForm {
  private s = inject(Store);
  done = output<void>();
  path = signal('');
  submit(event: Event) {
    event.preventDefault();
    const p = this.path().trim(); if (!p) return;
    this.s.addProject(p);
    this.done.emit();
  }
}
