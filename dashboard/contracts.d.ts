export interface ApiError { error: { code: string; message: string; retryable: boolean } }
export interface ProjectRef { id: string; name: string; path: string; origin: 'session' | 'saved'; local: boolean }
export interface Resolution { root: string; origin: string; warnings: string[] }
export interface Context {
  readOnly: boolean; platform: string; projects: ProjectRef[];
  primaryRoot: string; deployment: Resolution; library: string;
}
export interface Source {
  id: string; key: string; name: string; kind: 'primary' | 'local' | 'git'; location: string; root: string;
  state: 'available' | 'missing' | 'not-fetched' | 'unreadable' | 'rejected';
  revision: string | null; count: number | null; rejectionCount: number; error: string | null;
}
export interface Skill {
  id: string; name: string; sourceId: string; relativePath: string; digest?: string | null;
  /** For skills in the library: the skill's own category, and the length of its description. What a set is built from. */
  category?: string; descriptionChars?: number;
}
/** One rule of a set: select skills by name, name pattern, source or category; an exclude removes what it selects. */
export interface SetRule { type: 'skill' | 'name' | 'source' | 'category'; value: string; exclude?: boolean }
/** A stored set. built: its folder of links exists. */
export interface SetInfo { name: string; rules: SetRule[]; built: boolean }
export interface Rejection { sourceId: string; path: string; reason: string }
/** kind: what a person needs to do. identical = nothing; choice/order = settled; default = worth a look; changed = a copy changed since you chose. */
export type ClashKind = 'identical' | 'choice' | 'order' | 'default' | 'changed';
export interface Collision {
  name: string; winnerId: string; candidateIds: string[]; preferredSourceId: string | null;
  kind: ClashKind; by: 'choice' | 'order' | 'default'; stale: boolean; changedSourceIds: string[]; identicalIds: string[];
}
export type AgentTool = 'claude' | 'codex' | 'gemini' | 'cursor';
export interface LintFinding { skillId: string; skill: string; code: string; severity: 'error' | 'warn' | 'info'; tools: AgentTool[]; message: string }
export interface ListingBudget { entries: number; withoutDescription: number; descriptionChars: number; budgetChars: number; kept: number; dropped: number; fits: boolean }
/**
 * A personal skill that hides a library skill of the same name. path is the personal folder, libraryPath the folder
 * the library takes its copy from. same: the two have identical content (null when either could not be read or is too large).
 */
export interface Shadow {
  name: string; tool: AgentTool; level: string; path: string; skillId: string | null;
  libraryPath: string | null; same: boolean | null;
  personalDescription: string; libraryDescription: string; personalFiles: number | null; libraryFiles: number | null;
}
/** A personal skill that was set aside. from: where Restore puts it back. heldAt: where it is now. restorable: nothing sits at `from` now. */
export interface SetAsideItem { tool: AgentTool; name: string; at: string | null; from: string; heldAt: string; restorable: boolean }
/**
 * A skills folder of the owner's own that nothing here manages. own: skills only here. shared: same name as a library skill (yours is kept).
 * incoming: library skills Adopt would copy in. others: entries that are not skills.
 */
export interface Adoptable { own: string[]; shared: string[]; incoming: number; others: number }
export interface LibraryHealth { findings: LintFinding[]; counts: { error: number; warn: number; info: number }; budget: ListingBudget; shadows: Shadow[] }
export interface LibraryState {
  path: string; built: boolean; builtAt: string | null; invalid: boolean; size: number;
  add: string[]; remove: string[]; change: string[]; inSync: boolean | null;
}
export type Feeds = 'library' | 'set' | 'vault' | 'elsewhere' | 'broken' | 'copy' | 'needs-copy' | 'blocked' | 'unreadable' | 'none';
/** What the tool itself last reported. stale = the skills folder has changed since it was asked. */
export interface Verification { level: 'verified' | 'partial' | 'not-listed' | 'unreliable' | 'not-wired' | 'unavailable'; tool: string; detail: string; at: string; stale: boolean }
export interface CopyInfo { state: 'fresh' | 'stale'; copiedAt: string | null }
export interface TargetReport {
  id: string; dir: string; doc: string; docExists: boolean; optIn: boolean; copy: CopyInfo | null; /** null unless the folder is unmanaged and the library is built. */ adoptable: Adoptable | null; verification: Verification | null; kind: string; health: string;
  resolvedTarget: string | null; feeds: Feeds; /** The set this agent reads, when feeds is set. */ set: string | null; entries: number | null; match: 'matches' | 'differs' | 'unknown';
}
export interface ProjectReport {
  project: ProjectRef; readAt: string; deployment: Resolution; targets: TargetReport[];
  state: 'available' | 'missing' | 'unreadable'; warnings: string[];
}
/** added: new in the library. removed: gone. changed: the content differs. moved: the same content, from another source. */
export interface LockChanges { builtAt: string; first: boolean; added: string[]; removed: string[]; changed: string[]; moved: string[] }
export interface Catalog {
  generation: string; startedAt: string; completedAt: string; status: 'complete' | 'partial';
  sources: Source[]; skills: Skill[]; winnerIds: string[]; collisions: Collision[];
  rejected: Rejection[]; warnings: string[]; mergeAvailable: boolean;
  library: LibraryState; projects: ProjectReport[];
  /** null when a source is unavailable, because the library's contents are then unknown. */
  health: LibraryHealth | null;
  /** Source ids, highest priority first, as applied. Explicit = you set an order; otherwise it is the built-in one. */
  sourceOrder: string[]; sourceOrderExplicit: boolean;
  /** What changed in the sources since the library was last built, from the lock record. null when there is no usable record or a source is unavailable. */
  sinceLastBuild: LockChanges | null;
  /** The stored skill sets. */
  sets: SetInfo[];
  /** What is set aside from the personal folders now. */
  setAside: SetAsideItem[];
}
export interface CompareSide { id: string; sourceId: string; name: string; relativePath: string; digest: string | null; changedAt: string | null; fileCount: number | null; scriptCount: number | null }
export interface DiffHunk { type: 'same' | 'add' | 'del' | 'skip'; text?: string; count?: number; a?: number; b?: number }
export interface SkillComparison {
  generation: string; readAt: string; a: CompareSide; b: CompareSide; identical: boolean;
  fields: { key: string; a: string | null; b: string | null; same: boolean }[];
  files: { path: string; inA: boolean; inB: boolean; runs: boolean; same: boolean }[] | null;
  body: { tooLarge: boolean; added: number; removed: number; hunks: DiffHunk[] };
}
export interface SkillDocument { id: string; sourceId: string; relativePath: string; text: string; readAt: string }

export type ChangeKind = 'source.attach' | 'source.detach' | 'source.fetch' | 'library.prefer' | 'library.order' | 'library.rebuild' | 'project.add' | 'project.forget' | 'project.wire' | 'project.verify' | 'set.save' | 'set.remove' | 'skill.setaside' | 'skill.restore' | 'project.adopt';
export interface Change { kind: ChangeKind; args?: Record<string, unknown> }
export interface ChangeLine { tone: 'add' | 'remove' | 'change' | 'note' | 'warn'; text: string }
export interface ChangePreview { kind: ChangeKind; title: string; lines: ChangeLine[]; conflicts: string[]; ok: boolean; args?: Record<string, unknown> }
export interface ChangeResult { kind: ChangeKind; title: string; status: 'applied' | 'refused' | 'failed' | 'skipped'; lines: ChangeLine[]; message: string }
export interface ApplyResponse { results: ChangeResult[] }
