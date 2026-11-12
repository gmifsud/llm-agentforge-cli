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
export interface Skill { id: string; name: string; sourceId: string; relativePath: string; digest?: string | null }
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
export interface Shadow { name: string; tool: AgentTool; level: string; path: string; skillId: string | null }
export interface LibraryHealth { findings: LintFinding[]; counts: { error: number; warn: number; info: number }; budget: ListingBudget; shadows: Shadow[] }
export interface LibraryState {
  path: string; built: boolean; builtAt: string | null; invalid: boolean; size: number;
  add: string[]; remove: string[]; change: string[]; inSync: boolean | null;
}
export type Feeds = 'library' | 'vault' | 'elsewhere' | 'broken' | 'copy' | 'needs-copy' | 'blocked' | 'unreadable' | 'none';
export interface CopyInfo { state: 'fresh' | 'stale'; copiedAt: string | null }
export interface TargetReport {
  id: string; dir: string; doc: string; docExists: boolean; optIn: boolean; copy: CopyInfo | null; kind: string; health: string;
  resolvedTarget: string | null; feeds: Feeds; entries: number | null; match: 'matches' | 'differs' | 'unknown';
}
export interface ProjectReport {
  project: ProjectRef; readAt: string; deployment: Resolution; targets: TargetReport[];
  state: 'available' | 'missing' | 'unreadable'; warnings: string[];
}
export interface Catalog {
  generation: string; startedAt: string; completedAt: string; status: 'complete' | 'partial';
  sources: Source[]; skills: Skill[]; winnerIds: string[]; collisions: Collision[];
  rejected: Rejection[]; warnings: string[]; mergeAvailable: boolean;
  library: LibraryState; projects: ProjectReport[];
  /** null when a source is unavailable, because the library's contents are then unknown. */
  health: LibraryHealth | null;
  /** Source ids, highest priority first, as applied. Explicit = you set an order; otherwise it is the built-in one. */
  sourceOrder: string[]; sourceOrderExplicit: boolean;
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

export type ChangeKind = 'source.attach' | 'source.detach' | 'source.fetch' | 'library.prefer' | 'library.order' | 'library.rebuild' | 'project.add' | 'project.forget' | 'project.wire';
export interface Change { kind: ChangeKind; args?: Record<string, unknown> }
export interface ChangeLine { tone: 'add' | 'remove' | 'change' | 'note' | 'warn'; text: string }
export interface ChangePreview { kind: ChangeKind; title: string; lines: ChangeLine[]; conflicts: string[]; ok: boolean; args?: Record<string, unknown> }
export interface ChangeResult { kind: ChangeKind; title: string; status: 'applied' | 'refused' | 'failed' | 'skipped'; lines: ChangeLine[]; message: string }
export interface ApplyResponse { results: ChangeResult[] }
