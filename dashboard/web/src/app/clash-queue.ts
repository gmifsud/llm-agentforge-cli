import { Component, computed, effect, inject, input, output, signal, untracked } from '@angular/core';
import { RouterLink } from '@angular/router';
import { Store, type QueueRow, type Skill, type Suggestion } from './store';

/**
 * One name clash, settled in place: pick the copy that keeps the plain name, then type a name and a description for
 * each copy that differs. Used on the Skills page and above the cards on the compare page.
 */
@Component({ selector: 'af-clash-row', imports: [RouterLink], template: `
  <article class="clash-item" tabindex="-1" [attr.id]="'clash-' + row().collision.name" [attr.aria-label]="'Name clash: ' + row().collision.name">
    <header class="clash-head">
      <h3>{{ row().collision.name }}</h3>
      <span class="fine">{{ differing() }} {{ differing() === 1 ? 'copy differs' : 'copies differ' }}</span>
      <a class="button quiet tiny" [routerLink]="['/compare', row().collision.name]" [attr.aria-label]="'Compare the copies of ' + row().collision.name">Compare</a>
    </header>

    @if (row().collision.resolved) {
      <p class="state live">Kept as {{ row().collision.keptNames.join(', ') }}</p>
      <div class="actions">
        @for (kept of row().collision.keptNames; track kept) {
          <button type="button" class="quiet tiny" (click)="s.unkeep(kept)" [disabled]="s.changesLocked()" [attr.aria-label]="'Stop keeping ' + kept">Stop keeping {{ kept }}</button>
        }
      </div>
    } @else {
      <fieldset class="clash-copies">
        <legend class="sr">Which copy keeps the name {{ row().collision.name }}</legend>
        @for (skill of copies(); track skill.id) {
          <div class="clash-copy">
            <label class="inline">
              <input type="radio" [name]="'main-' + row().collision.name" [checked]="skill.id === main().id" (change)="mainId.set(skill.id)" [disabled]="row().planned || s.changesLocked()">
              <span>{{ s.sourceName(skill.sourceId) }}</span>
              @if (skill.id === main().id) { <span class="fine">keeps the name <code>{{ row().collision.name }}</code></span> }
              @else if (isSameAsMain(skill)) { <span class="fine">identical to the main copy, nothing to name</span> }
            </label>
            @if (entry(skill); as o) {
              <div class="keep-fields">
                <label [for]="'keep-name-' + skill.id">Keep as</label>
                <input [id]="'keep-name-' + skill.id" [value]="name(skill)" (input)="setName(skill, $any($event.target).value)"
                       [disabled]="row().planned || s.changesLocked()" [attr.aria-invalid]="nameError(skill) ? 'true' : null" [attr.aria-describedby]="'keep-name-err-' + skill.id" autocomplete="off" spellcheck="false">
                @if (origin(skill); as label) { <p class="fine origin">{{ label }}</p> }
                @if (nameError(skill)) { <p class="field-error" role="alert" [id]="'keep-name-err-' + skill.id">{{ nameError(skill) }}</p> }
                <label [for]="'keep-desc-' + skill.id">Description</label>
                <textarea [id]="'keep-desc-' + skill.id" rows="3" [value]="description(skill)" (input)="setDescription(skill, $any($event.target).value)"
                          [disabled]="row().planned || s.changesLocked()" [attr.aria-invalid]="descriptionError(skill) ? 'true' : null" [attr.aria-describedby]="'keep-desc-err-' + skill.id"></textarea>
                <p class="fine" [class.over]="description(skill).length > 900">{{ description(skill).length }} / 900</p>
                @if (descriptionError(skill)) { <p class="field-error" role="alert" [id]="'keep-desc-err-' + skill.id">{{ descriptionError(skill) }}</p> }
                @if (o.also.length) { <p class="fine">Identical copy in {{ alsoNames(o.also) }}. One entry covers them all.</p> }
              </div>
            }
          </div>
        }
      </fieldset>
      @if (differs(); as d) { <p class="fine">Differs: {{ d }}</p> }
      @if (suggestError(); as why) { <p class="field-error" role="alert">Could not suggest names: {{ why }}</p> }
      @if (row().planned) { <p class="planned-note">Will be kept when you apply</p> }
      <div class="actions">
        <button type="button" class="primary" (click)="approve()" [disabled]="!ready() || row().planned || s.changesLocked()">Approve</button>
        <button type="button" class="quiet" (click)="keepOnlyOne()" [disabled]="row().planned || s.changesLocked()">Keep only one</button>
        <button type="button" class="quiet" (click)="suggestAgain()" [disabled]="row().planned || !entries().length || suggestingNow()">{{ suggestingNow() ? 'Suggesting…' : suggested() ? 'Suggest again' : 'Suggest names' }}</button>
        @if (canSkip()) { <button type="button" class="quiet" (click)="skip.emit(row().collision.name)">Skip</button> }
      </div>
    }
  </article>
` })
export class ClashRow {
  s = inject(Store);
  row = input.required<QueueRow>();
  /** The queue page can set a clash aside for the session; the compare page has nothing to collapse. */
  canSkip = input(false);
  skip = output<string>();

  /** The copy chosen to keep the plain name. Null until the person picks another, so it follows the current winner. */
  mainId = signal<string | null>(null);
  private names = signal<Record<string, string>>({});
  private descriptions = signal<Record<string, string>>({});
  private nameEdited = signal<Record<string, boolean>>({});
  private descriptionEdited = signal<Record<string, boolean>>({});

  constructor() {
    // Fill what the person has not typed from the suggestions for this clash, whenever they arrive or the copies change.
    effect(() => {
      const suggestions = this.s.suggestions().get(this.row().collision.name);
      const entries = this.entries();
      if (!suggestions) return;
      untracked(() => {
        for (const o of entries) {
          const suggestion = this.suggestionFor(o.skill); if (!suggestion) continue;
          if (!this.nameEdited()[o.skill.id]) this.names.update(m => ({ ...m, [o.skill.id]: suggestion.name }));
          if (!this.descriptionEdited()[o.skill.id]) this.descriptions.update(m => ({ ...m, [o.skill.id]: suggestion.description }));
        }
      });
    });
  }

  main = computed(() => (this.mainId() && this.row().collision.candidateIds.includes(this.mainId()!) ? this.s.skillById(this.mainId()!) : null) || this.row().main);
  entries = computed(() => this.s.othersFor(this.row().collision, this.main()));
  copies = computed(() => this.row().collision.candidateIds.map(id => this.s.skillById(id)).filter((x): x is Skill => !!x));
  differing = computed(() => this.entries().reduce((n, o) => n + 1 + o.also.length, 0));

  entry(skill: Skill) { return this.entries().find(o => o.skill.id === skill.id) || null; }
  isSameAsMain(skill: Skill) { return skill.id !== this.main().id && !this.entries().some(o => o.skill.id === skill.id || o.also.some(a => a.id === skill.id)); }
  alsoNames(also: Skill[]) { return also.map(a => this.s.sourceName(a.sourceId)).join(', '); }
  name(skill: Skill) { return this.names()[skill.id] ?? ''; }
  description(skill: Skill) { return this.descriptions()[skill.id] ?? ''; }
  /** Typing marks a field as the person's own; a suggestion never replaces it. */
  setName(skill: Skill, value: string) { this.names.update(m => ({ ...m, [skill.id]: value })); this.nameEdited.update(m => ({ ...m, [skill.id]: true })); }
  setDescription(skill: Skill, value: string) { this.descriptions.update(m => ({ ...m, [skill.id]: value })); this.descriptionEdited.update(m => ({ ...m, [skill.id]: true })); }

  /** Shown once something is typed; an empty field only keeps Approve disabled. */
  nameError(skill: Skill): string {
    const typed = this.name(skill);
    if (!typed) return '';
    const plain = this.row().collision.name;
    const clash = this.entries().some(o => o.skill.id !== skill.id && this.name(o.skill).toLowerCase() === typed.toLowerCase());
    return this.s.nameProblem(plain, typed) || (clash ? 'another copy in this clash uses that name' : '') || '';
  }
  descriptionError(skill: Skill): string { return this.description(skill) ? this.s.descriptionProblem(this.description(skill)) || '' : ''; }
  ready = computed(() => this.entries().length > 0 && this.entries().every(o =>
    !!this.name(o.skill) && !this.nameError(o.skill) && !this.s.descriptionProblem(this.description(o.skill))));
  /** The suggestion for the copy that stands for this entry: the one made for its source. */
  suggestionFor(skill: Skill): Suggestion | null {
    const key = this.s.sourceById(skill.sourceId)?.key;
    return key ? this.s.suggestions().get(this.row().collision.name)?.find(x => x.source === key) || null : null;
  }
  /** Where an entry's text came from. Typing in either field makes it the person's own. */
  origin(skill: Skill): string {
    if (this.nameEdited()[skill.id] || this.descriptionEdited()[skill.id]) return 'typed by you';
    const by = this.suggestionFor(skill)?.by;
    return by === 'fallback' ? 'fallback suggestion' : by ? 'suggested by Claude' : '';
  }
  /** What differs between the copies, as suggested; each copy is named when there is more than one. */
  differs(): string {
    const parts = this.entries().flatMap(o => { const d = this.suggestionFor(o.skill)?.difference; return d ? [{ source: this.s.sourceName(o.skill.sourceId), d }] : []; });
    return parts.length > 1 ? parts.map(p => `${p.source}: ${p.d}`).join('; ') : parts[0]?.d || '';
  }
  suggested = computed(() => this.s.suggestions().has(this.row().collision.name));
  suggestingNow = computed(() => this.s.suggesting().has(this.row().collision.name));
  suggestError = computed(() => this.s.suggestErrors().get(this.row().collision.name) || '');
  /** Ask again, bypassing the cache. Fields the person has typed in are left alone. */
  suggestAgain() { void this.s.suggestOne(this.row().collision.name, true, this.s.sourceById(this.main().sourceId) || undefined); }

  approve() {
    if (!this.ready()) return;
    const mainSource = this.s.sourceById(this.main().sourceId); if (!mainSource) return;
    const keep = this.entries().flatMap(o => {
      const source = this.s.sourceById(o.skill.sourceId);
      return source ? [{ source, name: this.name(o.skill), description: this.description(o.skill) }] : [];
    });
    this.s.keep(this.row().collision.name, mainSource, keep);
  }
  keepOnlyOne() { this.s.prefer(this.row().collision.name, this.s.sourceById(this.main().sourceId)); }
}

/** The Skills page's Name clashes view: every clash that still needs deciding, then the resolved ones on request. */
@Component({ selector: 'af-clash-queue', imports: [ClashRow], template: `
  <section class="clash-queue" aria-labelledby="h-clash-queue">
    <header class="clash-queue-head">
      <h2 id="h-clash-queue">Name clashes</h2>
      <p class="fine" role="status">{{ undecided().length }} to decide · {{ resolved().length }} resolved</p>
    </header>
    @if (targets().length || s.suggestProgress()) {
      <div class="suggest-bar">
        @if (confirming()) {
          <div class="suggest-confirm" role="group" aria-label="Confirm suggestions">
            <p>Sends one short question per clash to Claude on your account. Nothing changes until you approve and apply.</p>
            <div class="actions">
              <button type="button" class="primary" (click)="suggestAll()">Suggest names</button>
              <button type="button" class="quiet" (click)="confirming.set(false)">Cancel</button>
            </div>
          </div>
        } @else if (targets().length) {
          <button type="button" class="quiet" (click)="confirming.set(true)" [disabled]="s.suggestRunning()">Suggest names for {{ targets().length }}</button>
        }
        @if (s.suggestProgress(); as p) { <p class="fine" role="status">{{ p.done }} of {{ p.total }} clashes suggested</p> }
      </div>
    }
    @for (row of undecided(); track row.collision.name) {
      <af-clash-row [row]="row" [canSkip]="true" (skip)="skip($event)" />
    }
    @if (!undecided().length) { <p class="empty">Nothing is waiting for a decision.</p> }
    @if (skippedCount()) {
      <p class="fine">{{ skippedCount() }} set aside for now. <button type="button" class="quiet tiny" (click)="skipped.set(emptySet)">Bring back</button></p>
    }
    @if (resolved().length) {
      <button type="button" class="quiet tiny" (click)="showResolved.set(!showResolved())" [attr.aria-expanded]="showResolved()">{{ showResolved() ? 'Hide' : 'Show' }} resolved ({{ resolved().length }})</button>
      @if (showResolved()) {
        @for (row of resolved(); track row.collision.name) { <af-clash-row [row]="row" /> }
      }
    }
  </section>
` })
export class ClashQueue {
  s = inject(Store);
  constructor() {
    // Rename on a kept copy sends us here: make sure that clash's row is showing, then bring it into view and focus it.
    effect(() => {
      const name = this.s.focusedClash(); if (!name) return;
      untracked(() => {
        this.skipped.update(set => { const next = new Set(set); next.delete(name); return next; });
        if (this.resolved().some(r => r.collision.name === name)) this.showResolved.set(true);
        this.s.focusedClash.set('');
        setTimeout(() => { const el = document.getElementById('clash-' + name); el?.scrollIntoView({ block: 'center' }); el?.focus(); });
      });
    });
  }
  readonly emptySet = new Set<string>();
  /** Component-local, so it resets on reload. */
  skipped = signal<Set<string>>(this.emptySet);
  showResolved = signal(false);
  private all = computed(() => this.s.queueRows());
  resolved = computed(() => this.all().filter(r => r.collision.resolved));
  private open = computed(() => this.all().filter(r => !r.collision.resolved));
  undecided = computed(() => this.open().filter(r => !this.skipped().has(r.collision.name)));
  skip(name: string) { this.skipped.update(set => new Set(set).add(name)); }
  /** Clashes shown here that have no suggestion yet. */
  targets = computed(() => this.s.suggestTargets(this.undecided().map(r => r.collision.name)));
  confirming = signal(false);
  suggestAll() { this.confirming.set(false); void this.s.suggestAll(this.undecided().map(r => r.collision.name)); }
  skippedCount = computed(() => this.open().length - this.undecided().length);
}
