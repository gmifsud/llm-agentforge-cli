import { Component, computed, effect, inject, signal, untracked } from '@angular/core';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import { toSignal } from '@angular/core/rxjs-interop';
import { map } from 'rxjs';
import { Store, type SetRule } from './store';
import { RULE_KINDS, fitBudget, libraryEntries, resolveRules, ruleMatches, ruleText, type LibraryEntry } from './set-rules';
import { DEFAULT_BUDGET_CHARS } from './sets';

const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const RESERVED = ['library', 'vault', 'merged-skills'];
const LIST_LIMIT = 200;
type Show = 'all' | 'in' | 'out' | 'nocat';

/**
 * Create a set, or change one. Everything here is local until Save, which queues one change in the review sheet.
 * The list and the budget are worked out in the page from the rules, so they update as you add and tick; the server
 * checks the same rules again and its preview is the final word.
 */
@Component({ selector: 'af-set-editor', imports: [RouterLink], templateUrl: './set-editor.html' })
export class SetEditor {
  s = inject(Store);
  private router = inject(Router);
  private route = inject(ActivatedRoute);
  kinds = RULE_KINDS;

  paramName = toSignal(this.route.paramMap.pipe(map(p => p.get('name') || 'new')), { initialValue: 'new' });
  isNew = computed(() => this.paramName() === 'new');
  name = signal('');
  rules = signal<SetRule[]>([]);
  kind = signal<SetRule['type']>('category');
  value = signal('');
  query = signal('');
  show = signal<Show>('all');
  private loaded = '';

  constructor() {
    // The rules of the set being edited are loaded once the catalogue is there.
    effect(() => {
      const n = this.paramName(), c = this.s.catalog();
      if (!c || this.loaded === n) return;
      this.loaded = n;
      untracked(() => {
        const set = n === 'new' ? null : c.sets.find(x => x.name === n);
        this.name.set(set ? set.name : '');
        this.rules.set(set ? set.rules.map(r => ({ ...r })) : []);
      });
    });
  }

  library = computed(() => { const c = this.s.catalog(); return c ? libraryEntries(c) : []; });
  budgetChars = computed(() => this.s.catalog()?.health?.budget.budgetChars ?? DEFAULT_BUDGET_CHARS);
  resolved = computed(() => resolveRules(this.rules(), this.library()));
  fit = computed(() => fitBudget(this.resolved().entries.map(e => e.chars), this.budgetChars()));
  private inSet = computed(() => new Set(this.resolved().entries.map(e => e.name.toLowerCase())));
  categories = computed(() => this.tally(e => e.category));
  sourceChoices = computed(() => this.tally(e => e.source));
  hint = computed(() => RULE_KINDS.find(k => k.type === this.kind())?.hint ?? '');
  percent = computed(() => { const f = this.fit(), d = f.kept + f.dropped; return f.fits || !d ? 100 : Math.round((f.kept / d) * 100); });
  /** How many more skills of the same average length would still fit. */
  room = computed(() => { const f = this.fit(), n = this.resolved().entries.length; return !f.fits || !n || !f.usedChars ? 0 : Math.floor((f.budgetChars - f.usedChars) / (f.usedChars / n)); });

  nameProblem = computed(() => {
    const n = this.name();
    if (!NAME_RE.test(n)) return 'Use letters, digits, "-", "_" or "." (not first), up to 64 characters.';
    if (RESERVED.includes(n.toLowerCase())) return `"${n}" is reserved.`;
    if (this.s.catalog()?.sets.some(x => x.name.toLowerCase() === n.toLowerCase())) return `A set called "${n}" already exists.`;
    return '';
  });
  saveProblem = computed(() => {
    if (this.isNew() && !this.name()) return 'Give the set a name.';
    if (this.isNew() && this.nameProblem()) return this.nameProblem();
    if (!this.rules().some(r => !r.exclude)) return 'Add at least one rule that includes skills.';
    const u = this.resolved().unmatched;
    return u.length ? `${u.map(ruleText).join(', ')} selects no skill. Remove it or change it.` : '';
  });
  canSave = computed(() => !this.saveProblem());

  private filtered = computed(() => {
    const q = this.query().trim().toLowerCase(), mode = this.show();
    return this.library().filter(e => (!q || `${e.name} ${e.category} ${e.source}`.toLowerCase().includes(q))
      && (mode === 'all' || (mode === 'in' && this.has(e)) || (mode === 'out' && !this.has(e)) || (mode === 'nocat' && !e.category)));
  });
  visible = computed(() => this.filtered().slice(0, LIST_LIMIT));
  hidden = computed(() => Math.max(0, this.filtered().length - LIST_LIMIT));

  has(e: LibraryEntry) { return this.inSet().has(e.name.toLowerCase()); }
  /** Why a skill is, or is not, in the set: the last rule that touched it. */
  why(e: LibraryEntry) {
    const rules = this.rules();
    for (let i = rules.length - 1; i >= 0; i--) if (ruleMatches(rules[i], e)) return rules[i].exclude ? 'left out' : rules[i].type === 'skill' ? 'picked by hand' : ruleText(rules[i]);
    return 'not in this set';
  }

  private tally(key: (e: LibraryEntry) => string) {
    const counts = new Map<string, number>();
    for (const e of this.library()) { const k = key(e); if (k) counts.set(k, (counts.get(k) ?? 0) + 1); }
    return [...counts].map(([value, count]) => ({ value, count })).sort((a, b) => b.count - a.count || a.value.localeCompare(b.value));
  }

  setKind(kind: string) { this.kind.set(kind as SetRule['type']); this.value.set(''); }
  setShow(mode: string) { this.show.set(mode as Show); }

  addRule(event: Event) {
    event.preventDefault();
    const value = this.value().trim();
    if (!value) return;
    const type = this.kind();
    if (!this.rules().some(r => !r.exclude && r.type === type && r.value.toLowerCase() === value.toLowerCase())) this.rules.update(list => [...list, { type, value }]);
    this.value.set('');
  }
  removeRule(index: number) { this.rules.update(list => list.filter((_, i) => i !== index)); }

  /** Ticking adds a skill by hand, or puts back one that was left out; unticking removes a hand pick, or leaves out one a rule brought in. */
  toggleSkill(name: string, on: boolean) {
    const key = name.toLowerCase();
    const own = (r: SetRule) => r.type === 'skill' && r.value.toLowerCase() === key;
    const included = (rules: SetRule[]) => resolveRules(rules, this.library()).entries.some(e => e.name.toLowerCase() === key);
    let next = [...this.rules()];
    if (on) {
      next = next.filter(r => !(own(r) && r.exclude));
      if (!included(next)) next.push({ type: 'skill', value: name });
    } else {
      next = next.filter(r => !(own(r) && !r.exclude));
      if (included(next)) next.push({ type: 'skill', value: name, exclude: true });
    }
    this.rules.set(next);
  }

  save() {
    if (!this.canSave()) return;
    this.s.saveSet(this.name(), this.rules(), !this.isNew());
    void this.router.navigateByUrl('/sets');
  }
}
