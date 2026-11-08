export interface ApiError { error: { code: string; message: string; retryable: boolean } }
export interface ProjectRef { id: string; name: string; path: string }
export interface Resolution { root: string; origin: string; warnings: string[] }
export interface Context {
  readOnly: true; platform: string; projects: ProjectRef[];
  primaryRoot: string; deployment: Resolution;
}
export interface Source {
  id: string; name: string; kind: 'primary' | 'local' | 'git'; location: string; root: string;
  state: 'available' | 'missing' | 'not-fetched' | 'unreadable' | 'rejected';
  revision: string | null; count: number | null; rejectionCount: number; error: string | null;
}
export interface Skill { id: string; name: string; sourceId: string; relativePath: string }
export interface Rejection { sourceId: string; path: string; reason: string }
export interface Collision { name: string; winnerId: string; candidateIds: string[] }
export interface Catalog {
  generation: string; startedAt: string; completedAt: string; status: 'complete' | 'partial';
  sources: Source[]; skills: Skill[]; winnerIds: string[]; collisions: Collision[];
  rejected: Rejection[]; warnings: string[]; mergeAvailable: boolean;
}
export interface SkillDocument { id: string; sourceId: string; relativePath: string; text: string; readAt: string }
export interface TargetReport {
  id: string; doc: string; docExists: boolean; kind: string; health: string;
  resolvedTarget: string | null; match: 'matches' | 'differs' | 'unknown';
}
export interface ProjectReport {
  project: ProjectRef; readAt: string; deployment: Resolution; targets: TargetReport[];
  state: 'available' | 'missing' | 'unreadable'; warnings: string[];
}
