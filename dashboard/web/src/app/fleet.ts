import { Component, Injector, afterNextRender, computed, inject, signal } from '@angular/core';
import { RouterLink } from '@angular/router';
import { Store, type Source } from './store';
import { ProjectDetail } from './project-detail';
import { SourceDetail } from './source-detail';
import { AttachForm, ProjectForm } from './fleet-forms';
import { LibraryCard } from './library-card';
import { groupAttention, groupHealth, groupRows, matchesProjectFilter, matchesProjectQuery, pendingChecks, pickState, projectCounts, projectRow, verifiableTargets, verifiedText, withPicked, type ProjectFilter, type ProjectGroup } from './project-status';
import { matchesFilter, matchesQuery, sourceCounts, sourceLabel, sourceStatus, needsAttention, type SourceFilter } from './source-status';

export type Layout = 'both' | 'sources' | 'projects';
const LAYOUT_KEY = 'agentforge.fleet.layout';
const LAYOUTS: Layout[] = ['both', 'sources', 'projects'];

/** The layout is a preference, so it survives a reload. Storage can be blocked; the default then holds. */
function savedLayout(): Layout {
  try { const v = localStorage.getItem(LAYOUT_KEY) as Layout | null; if (v && LAYOUTS.includes(v)) return v; } catch { /* storage unavailable */ }
  return 'both';
}

/** What the side panel shows: one source, one project, or a form to add one. */
type Selection = { kind: 'source' | 'project'; id: string } | { kind: 'attach' | 'add-project' };

@Component({ selector: 'af-fleet', templateUrl: './fleet.html', imports: [ProjectDetail, SourceDetail, AttachForm, ProjectForm, LibraryCard, RouterLink] })
export class Fleet {
  s = inject(Store);
  private injector = inject(Injector);
  label = sourceLabel;
  status = sourceStatus;
  needsAttention = needsAttention;

  layout = signal<Layout>(savedLayout());
  query = signal('');
  filter = signal<SourceFilter>('all');
  projectFilter = signal<ProjectFilter>('all');

  counts = computed(() => sourceCounts(this.s.orderedSources()));
  /** Sources stay in priority order: that order decides which copy wins a same-name clash, so it is never re-sorted here. */
  rows = computed(() => this.s.orderedSources().filter(src => matchesFilter(src, this.filter()) && matchesQuery(src, this.query())));
  filtering = computed(() => this.filter() !== 'all' || this.query().trim() !== '');
  /** The order only matters once there is something to order. */
  showOrder = computed(() => this.s.attached().length > 0);
  /** Moving a source inside a filtered list would reorder a view of the list, not the list. */
  canReorder = computed(() => !this.filtering() && !this.s.applying());

  // ─── projects ───────────────────────────────────────────────────────────────
  private allProjects = computed(() => (this.s.catalog()?.projects || []).map(projectRow));
  projectCount = computed(() => projectCounts(this.allProjects()));
  projectRows = computed(() => this.allProjects().filter(r => matchesProjectFilter(r, this.projectFilter()) && matchesProjectQuery(r.report, this.query())));
  groups = computed(() => groupRows(this.projectRows()));
  private allGroups = computed(() => groupRows(this.allProjects()));
  projectsNarrowed = computed(() => this.projectFilter() !== 'all' || this.query().trim() !== '');
  /** Anything narrowed, for the one Clear button. */
  narrowed = computed(() => this.filtering() || this.projectFilter() !== 'all');

  /** A long list starts collapsed, so groups can be scanned; a short one starts open. A choice made by hand is kept. */
  private chosen = signal<Record<string, boolean>>({});
  private startsOpen = computed(() => this.allProjects().length <= 30);
  /** While searching or filtering, every group shows its matches: a collapsed group must not hide a result. */
  isOpen(g: ProjectGroup) { return this.projectsNarrowed() || (this.chosen()[g.key] ?? this.startsOpen()); }
  toggle(g: ProjectGroup) { this.chosen.update(c => ({ ...c, [g.key]: !this.isOpen(g) })); }
  setAll(open: boolean) { this.chosen.set(Object.fromEntries(this.allGroups().map(g => [g.key, open]))); }
  setProjectFilter(value: ProjectFilter) { this.projectFilter.set(this.projectFilter() === value && value !== 'all' ? 'all' : value); }
  groupHealth = groupHealth;
  groupAttention = groupAttention;
  verifiedText = (s: Parameters<typeof verifiedText>[0]) => verifiedText(s, iso => new Date(iso).toLocaleDateString(undefined, { day: 'numeric', month: 'short' }));

  // ─── selection for bulk actions ─────────────────────────────────────────────
  pickedSources = signal<ReadonlySet<string>>(new Set());
  pickedProjects = signal<ReadonlySet<string>>(new Set());
  private projectId = (r: { report: { project: { id: string } } }) => r.report.project.id;

  /** Only Git sources can be fetched, so only they can be ticked. */
  fetchableRows = computed(() => this.rows().filter(r => r.kind === 'git'));
  sourcePick = computed(() => pickState(this.fetchableRows().map(r => r.id), this.pickedSources()));
  projectPick = computed(() => pickState(this.projectRows().map(this.projectId), this.pickedProjects()));
  groupPick(g: ProjectGroup) { return pickState(g.rows.map(this.projectId), this.pickedProjects()); }
  pickSource(id: string, on: boolean) { this.pickedSources.set(withPicked(this.pickedSources(), [id], on)); }
  pickAllSources(on: boolean) { this.pickedSources.set(withPicked(this.pickedSources(), this.fetchableRows().map(r => r.id), on)); }
  pickProject(id: string, on: boolean) { this.pickedProjects.set(withPicked(this.pickedProjects(), [id], on)); }
  pickGroup(g: ProjectGroup, on: boolean) { this.pickedProjects.set(withPicked(this.pickedProjects(), g.rows.map(this.projectId), on)); }
  pickAllProjects(on: boolean) { this.pickedProjects.set(withPicked(this.pickedProjects(), this.projectRows().map(this.projectId), on)); }
  clearPicked() { this.pickedSources.set(new Set()); this.pickedProjects.set(new Set()); }

  /** Selected things that still exist; an id left over from a detached source or a forgotten project counts for nothing. */
  private chosenSources = computed(() => this.s.attached().filter(src => src.kind === 'git' && this.pickedSources().has(src.id)));
  private chosenProjects = computed(() => this.allProjects().filter(r => this.pickedProjects().has(this.projectId(r))));
  /** What each button would do right now: work already waiting in the review sheet is not counted again. */
  toFetch = computed(() => this.chosenSources().filter(src => !this.s.pendingFor('source.fetch', a => a['name'] === src.key || !a['name']).length));
  toVerify = computed(() => this.chosenProjects().flatMap(r => verifiableTargets(r.report)
    .filter(t => !this.s.pendingFor('project.verify', a => a['projectId'] === r.report.project.id && a['target'] === t.id).length)
    .map(t => ({ projectId: r.report.project.id, target: t.id }))));
  pickedCount = computed(() => this.chosenSources().length + this.chosenProjects().length);
  pickedText = computed(() => {
    const n = this.chosenSources().length, m = this.chosenProjects().length;
    return [n && `${n} ${n === 1 ? 'source' : 'sources'}`, m && `${m} ${m === 1 ? 'project' : 'projects'}`].filter(Boolean).join(' and ') + ' selected';
  });
  /** Selected but out of sight (filtered away, or in a list the layout hides): the bar says so, so a bulk action is never a surprise. */
  hiddenPicked = computed(() => {
    const seenSources = this.layout() === 'projects' ? new Set<string>() : new Set(this.rows().map(r => r.id));
    const seenProjects = this.layout() === 'sources' ? new Set<string>() : new Set(this.projectRows().map(this.projectId));
    return this.chosenSources().filter(src => !seenSources.has(src.id)).length + this.chosenProjects().filter(r => !seenProjects.has(this.projectId(r))).length;
  });
  fetchSelected() { this.s.fetchMany(this.toFetch()); }
  verifySelected() { this.s.verifyMany(this.toVerify()); }

  // ─── everything at once ─────────────────────────────────────────────────────
  /** Every Git source not already waiting to be fetched. */
  toFetchAll = computed(() => this.s.attached().filter(src => src.kind === 'git' && !this.s.pendingFor('source.fetch', a => a['name'] === src.key || !a['name']).length));
  /** Every working agent in every project that the tool has not confirmed, less checks already waiting. */
  toCheckAll = computed(() => pendingChecks(this.allProjects().map(r => r.report),
    i => this.s.pendingFor('project.verify', a => a['projectId'] === i.projectId && a['target'] === i.target).length > 0));
  fetchAll() { this.s.fetchMany(this.toFetchAll()); }
  checkAll() { this.s.verifyMany(this.toCheckAll()); }

  // ─── side panel ─────────────────────────────────────────────────────────────
  selection = signal<Selection | null>(null);
  /** Chosen by id, so a refresh that rebuilds the catalog keeps the panel on the same thing. */
  selectedSource = computed(() => { const sel = this.selection(); return sel?.kind === 'source' ? this.s.sourceById(sel.id) : null; });
  selectedProject = computed(() => { const sel = this.selection(); return sel?.kind === 'project' ? this.s.catalog()?.projects.find(p => p.project.id === sel.id) ?? null : null; });
  /** A chosen thing that is gone after a refresh or an apply (a detached source) leaves nothing to show. */
  drawerOpen = computed(() => { const sel = this.selection(); return !!sel && (sel.kind === 'attach' || sel.kind === 'add-project' || !!this.selectedSource() || !!this.selectedProject()); });
  /** What to give focus back to when the panel closes. */
  private opener: string | null = null;

  pendingAttach = computed(() => this.s.tray().filter(i => i.change.kind === 'source.attach'));
  pendingProjects = computed(() => this.s.tray().filter(i => i.change.kind === 'project.add'));

  isSelected(kind: 'source' | 'project', id: string) { const sel = this.selection(); return !!sel && sel.kind === kind && 'id' in sel && sel.id === id; }
  select(kind: 'source' | 'project', id: string) { this.opener = `[data-select="${kind}:${id}"]`; this.selection.set({ kind, id }); this.focus('drawer-title'); }
  openForm(kind: 'attach' | 'add-project') { this.opener = `[data-open="${kind}"]`; this.selection.set({ kind }); this.focus('drawer-title'); }
  close() {
    const back = this.opener; this.opener = null; this.selection.set(null);
    if (back) afterNextRender(() => document.querySelector<HTMLElement>(back)?.focus(), { injector: this.injector });
  }
  /** Move focus once the panel has been drawn, so a keyboard user lands in it rather than at the end of a long list. */
  private focus(id: string) { afterNextRender(() => document.getElementById(id)?.focus(), { injector: this.injector }); }

  setLayout(value: Layout) {
    this.layout.set(value);
    try { localStorage.setItem(LAYOUT_KEY, value); } catch { /* the choice still applies for this visit */ }
  }
  setFilter(value: SourceFilter) { this.filter.set(this.filter() === value && value !== 'all' ? 'all' : value); }
  clear() { this.query.set(''); this.filter.set('all'); this.projectFilter.set('all'); }
  /** Position among all sources, not among the rows that happen to be showing. */
  rank(src: Source) { return this.s.orderedSources().indexOf(src); }
  last() { return this.s.orderedSources().length - 1; }
  short(rev: string | null) { return rev ? rev.slice(0, 7) : ''; }
}
