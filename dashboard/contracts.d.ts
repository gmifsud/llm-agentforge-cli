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
export interface Skill { id: string; name: string; sourceId: string; relativePath: string }
export interface Rejection { sourceId: string; path: string; reason: string }
export interface Collision { name: string; winnerId: string; candidateIds: string[]; preferredSourceId: string | null }
export interface LibraryState {
  path: string; built: boolean; builtAt: string | null; invalid: boolean; size: number;
  add: string[]; remove: string[]; change: string[]; inSync: boolean | null;
}
export type Feeds = 'library' | 'vault' | 'elsewhere' | 'broken' | 'copy' | 'blocked' | 'unreadable' | 'none';
export interface TargetReport {
  id: string; dir: string; doc: string; docExists: boolean; kind: string; health: string;
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
}
export interface SkillDocument { id: string; sourceId: string; relativePath: string; text: string; readAt: string }

export type ChangeKind = 'source.attach' | 'source.detach' | 'source.fetch' | 'library.prefer' | 'library.rebuild' | 'project.add' | 'project.forget' | 'project.wire';
export interface Change { kind: ChangeKind; args?: Record<string, unknown> }
export interface ChangeLine { tone: 'add' | 'remove' | 'change' | 'note' | 'warn'; text: string }
export interface ChangePreview { kind: ChangeKind; title: string; lines: ChangeLine[]; conflicts: string[]; ok: boolean; args?: Record<string, unknown> }
export interface ChangeResult { kind: ChangeKind; title: string; status: 'applied' | 'refused' | 'failed' | 'skipped'; lines: ChangeLine[]; message: string }
export interface ApplyResponse { results: ChangeResult[] }
