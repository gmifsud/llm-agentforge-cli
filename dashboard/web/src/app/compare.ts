import { Component, computed, effect, inject, signal, untracked } from '@angular/core';
import { DatePipe } from '@angular/common';
import { ActivatedRoute, RouterLink } from '@angular/router';
import { toSignal } from '@angular/core/rxjs-interop';
import { map } from 'rxjs';
import { Store, type DiffHunk } from './store';

interface Row { skip?: number; left?: { n: number; text: string; changed: boolean }; right?: { n: number; text: string; changed: boolean } }

/** Two copies of one skill, side by side, with one decision to make: which one your agents get. */
@Component({ selector: 'af-compare', imports: [RouterLink, DatePipe], template: `
  <a routerLink="/" class="link back-link">Back to wiring</a>
  @if (clash(); as col) {
    <header class="page-head">
      <h1>{{ col.name }}</h1>
      <p>{{ candidates().length }} sources have a skill with this name. Your agents get one of them.{{ missing() }}</p>
    </header>

    <div class="cards">
      @for (cand of candidates(); track cand.skill.id) {
        <article class="card" [class.in-use]="cand.inUse" [class.selected]="cand.skill.id === otherId() || cand.inUse"
                 [attr.aria-label]="cand.sourceName + (cand.inUse ? ', in use' : '')">
          <h2>{{ cand.sourceName }} @if (cand.inUse) { <span class="tag">in use</span> }</h2>
          <p class="path">{{ slash(cand.skill.relativePath) }}</p>
          @if (side(cand.skill.id); as info) {
            <p class="fine">
              @if (info.changedAt) { Last changed {{ info.changedAt | date:'d MMM y' }}. }
              @if (info.fileCount !== null) { {{ info.fileCount }} {{ info.fileCount === 1 ? 'file' : 'files' }}@if (info.scriptCount) {, <strong>{{ info.scriptCount }} that can run</strong>}. }
            </p>
          }
          @if (cand.inUse) {
            <p class="state live">{{ inUseReason(col.by) }}</p>
            @if (col.kind === 'changed') { <p class="state caution">A copy has changed since you chose. Check it is still the one you want.</p> }
          } @else if (planned() === cand.sourceKey) {
            <p class="planned-note">Will be used when you apply your changes</p>
          } @else if (cand.identical) {
            <p class="state muted">Identical to the one in use</p>
          } @else {
            <div class="actions">
              <button type="button" class="primary" (click)="use(cand.sourceId)" [disabled]="s.applying()"
                      [attr.aria-label]="'Use the ' + col.name + ' from ' + cand.sourceName">Use this one</button>
              @if (candidates().length > 2 && cand.skill.id !== otherId()) {
                <button type="button" class="quiet" (click)="otherId.set(cand.skill.id)">Compare with the one in use</button>
              }
            </div>
          }
        </article>
      }
    </div>

    @if (s.compareError()) { <p class="notice fault" role="alert">{{ s.compareError() }}</p> }
    @if (s.compareBusy()) { <p class="muted" role="status">Reading both copies…</p> }
    @if (s.comparison(); as cmp) {
      @if (cmp.identical) {
        <p class="notice">These two copies are identical, file for file. There is nothing to choose between them.</p>
      } @else {
        <section class="differs" aria-labelledby="h-differs">
          <h2 id="h-differs">What differs</h2>
          <p class="fine">{{ nameOf(cmp.a.sourceId) }} on the left, {{ nameOf(cmp.b.sourceId) }} on the right.</p>
          <table>
            <thead><tr><th scope="col">Part</th><th scope="col">{{ nameOf(cmp.a.sourceId) }}</th><th scope="col">{{ nameOf(cmp.b.sourceId) }}</th></tr></thead>
            <tbody>
              @for (f of differing(); track f.key) {
                <tr><th scope="row">{{ f.key }}</th><td>{{ f.a ?? 'not set' }}</td><td>{{ f.b ?? 'not set' }}</td></tr>
              }
              @for (f of cmp.files || []; track f.path) {
                @if (!f.same) {
                  <tr><th scope="row">{{ f.path }}@if (f.runs) { <span class="tag runs">can run</span> }</th>
                    <td>{{ f.inA ? (f.inB ? 'different' : 'has it') : 'does not have it' }}</td><td>{{ f.inB ? (f.inA ? 'different' : 'has it') : 'does not have it' }}</td></tr>
                }
              }
            </tbody>
          </table>
          @if (sameFields().length) { <p class="fine">The same in both: {{ sameFields().join(', ') }}.</p> }
          @if (cmp.files === null) { <p class="fine">The file lists are too large to compare here.</p> }
        </section>

        <section aria-labelledby="h-instructions">
          <h2 id="h-instructions">Instructions</h2>
          @if (cmp.body.tooLarge) {
            <p class="fine">These instructions are too long to compare line by line here. Open each one from the Skills page.</p>
          } @else if (!cmp.body.added && !cmp.body.removed) {
            <p class="fine">The instructions are the same. Only the parts listed above differ.</p>
          } @else {
            <p class="fine">{{ cmp.body.removed }} {{ cmp.body.removed === 1 ? 'line' : 'lines' }} only on the left, {{ cmp.body.added }} only on the right.</p>
            <div class="diff" role="table" aria-label="Instructions, line by line">
              @for (row of rows(); track $index) {
                @if (row.skip) {
                  <div class="diff-skip" role="row"><span role="cell">{{ row.skip }} unchanged {{ row.skip === 1 ? 'line' : 'lines' }}</span></div>
                } @else {
                  <div class="diff-row" role="row">
                    <div class="diff-cell" role="cell" [class.del]="row.left?.changed" [class.blank]="!row.left">
                      @if (row.left; as l) { <span class="ln">{{ l.n }}</span><span class="sr">{{ l.changed ? 'only on the left: ' : '' }}</span><span class="tx">{{ l.text }}</span> }
                    </div>
                    <div class="diff-cell" role="cell" [class.add]="row.right?.changed" [class.blank]="!row.right">
                      @if (row.right; as r) { <span class="ln">{{ r.n }}</span><span class="sr">{{ r.changed ? 'only on the right: ' : '' }}</span><span class="tx">{{ r.text }}</span> }
                    </div>
                  </div>
                }
              }
            </div>
          }
        </section>
      }
    }
  } @else if (s.catalog()) {
    <p class="empty-state">No two sources have a skill called "{{ name() }}" any more. It may have been resolved, or a source was detached.</p>
  }
` })
export class Compare {
  s = inject(Store);
  private route = inject(ActivatedRoute);
  name = toSignal(this.route.paramMap.pipe(map(p => p.get('name') || '')), { initialValue: '' });
  otherId = signal('');

  clash = computed(() => this.s.clashByName(this.name()));
  candidates = computed(() => {
    const col = this.clash(); if (!col) return [];
    return col.candidateIds.map(id => this.s.skillById(id)).filter((x): x is NonNullable<typeof x> => !!x).map(skill => {
      const source = this.s.sourceById(skill.sourceId);
      return { skill, sourceId: skill.sourceId, sourceKey: source?.key || '', sourceName: this.s.sourceName(skill.sourceId), inUse: skill.id === col.winnerId, identical: col.identicalIds.includes(skill.id) };
    }).sort((a, b) => Number(b.inUse) - Number(a.inUse));
  });
  planned = computed(() => this.s.pendingFor('library.prefer', a => a['skill'] === this.name())[0]?.change.args?.['source'] as string | undefined);
  differing = computed(() => (this.s.comparison()?.fields || []).filter(f => !f.same));
  sameFields = computed(() => (this.s.comparison()?.fields || []).filter(f => f.same).map(f => f.key));

  /** Pair each run of removed lines with the added lines that replaced it, so a change reads across one row. */
  rows = computed<Row[]>(() => {
    const hunks: DiffHunk[] = this.s.comparison()?.body.hunks || [];
    const out: Row[] = [];
    for (let i = 0; i < hunks.length;) {
      const h = hunks[i];
      if (h.type === 'skip') { out.push({ skip: h.count }); i++; continue; }
      if (h.type === 'same') { out.push({ left: { n: h.a!, text: h.text!, changed: false }, right: { n: h.b!, text: h.text!, changed: false } }); i++; continue; }
      const dels: DiffHunk[] = [], adds: DiffHunk[] = [];
      while (i < hunks.length && hunks[i].type === 'del') dels.push(hunks[i++]);
      while (i < hunks.length && hunks[i].type === 'add') adds.push(hunks[i++]);
      for (let k = 0; k < Math.max(dels.length, adds.length); k++) {
        out.push({ left: dels[k] ? { n: dels[k].a!, text: dels[k].text!, changed: true } : undefined, right: adds[k] ? { n: adds[k].b!, text: adds[k].text!, changed: true } : undefined });
      }
    }
    return out;
  });

  constructor() {
    // Compare the one in use against the selected other copy; re-read whenever the catalogue is refreshed.
    effect(() => {
      const col = this.clash(); const generation = this.s.catalog()?.generation;
      if (!col || !generation) return;
      const others = col.candidateIds.filter(id => id !== col.winnerId);
      const other = others.includes(this.otherId()) ? this.otherId() : others[0];
      if (!other) return;
      untracked(() => { if (this.otherId() !== other) this.otherId.set(other); void this.s.compare(col.winnerId, other); });
    });
  }

  side(id: string) { const c = this.s.comparison(); return c ? (c.a.id === id ? c.a : c.b.id === id ? c.b : null) : null; }
  nameOf(sourceId: string) { return this.s.sourceName(sourceId); }
  slash(p: string) { return p.split('\\').join('/'); }
  inUseReason(by: string) { return by === 'choice' ? 'In use: your choice' : by === 'order' ? 'In use: higher in your source order' : 'In use: higher in the default order'; }
  missing() {
    const c = this.s.catalog(); const col = this.clash(); if (!c || !col) return '';
    const have = new Set(this.candidates().map(x => x.sourceId));
    const without = c.sources.filter(s => !have.has(s.id)).map(s => this.s.sourceName(s.id));
    return without.length ? ` ${without.join(' and ')} ${without.length === 1 ? 'does' : 'do'} not have it.` : '';
  }
  use(sourceId: string) { this.s.prefer(this.name(), this.s.sourceById(sourceId)); }
}
