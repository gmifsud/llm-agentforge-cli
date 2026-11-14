import { AGENTS, type ProjectReport, type TargetReport } from './store';

/** Shared by the wiring board, the map and the fleet view, so one agent never reads two different ways. */
export type Tone = 'live' | 'caution' | 'fault' | 'muted';

/** How a person calls a skill in each tool. Claude Code's was exercised for real; the rest are from each tool's documentation. */
export const INVOKE: Record<string, string> = {
  claude: 'Call a skill with /name',
  codex: 'Call a skill with $name, or pick one from /skills',
  gemini: 'Chosen by the agent. /skills list shows what it has',
  cursor: 'Type / and pick the skill',
  antigravity: 'Chosen by the agent; there is no direct command',
  generic: 'Read by Codex, Gemini CLI and Cursor',
};

/** What an agent actually reads, in words, with the tone that colours its socket. */
export function agentState(t: TargetReport): { text: string; tone: Tone } {
  switch (t.feeds) {
    case 'library': return { text: 'Reads the library', tone: 'live' };
    case 'set': return { text: `Reads the set ${t.set}`, tone: 'live' };
    case 'vault': return { text: 'Reads your vault only', tone: 'caution' };
    case 'elsewhere': return { text: 'Reads another folder', tone: 'caution' };
    case 'broken': return { text: 'Link is broken', tone: 'fault' };
    case 'needs-copy': return { text: `Linked, but ${AGENTS[t.id]} does not follow links. It needs a copy`, tone: 'caution' };
    case 'copy':
      if (t.copy?.state === 'fresh') return { text: 'Has a copy of the library, up to date', tone: 'live' };
      if (t.copy?.state === 'stale') return { text: 'Its copy is out of date: the library changed since', tone: 'caution' };
      return { text: `Has its own folder (${t.entries ?? 0} skills), not managed here`, tone: 'muted' };
    case 'blocked': return { text: 'A file is in the way', tone: 'fault' };
    case 'unreadable': return { text: 'Cannot be read', tone: 'fault' };
    default: return { text: 'Not wired', tone: 'muted' };
  }
}

/** What the tool itself last said, in words. Null when it has never been asked. */
export function verifiedLine(t: TargetReport): { text: string; good: boolean } | null {
  const v = t.verification; if (!v) return null;
  const when = new Date(v.at).toLocaleString(undefined, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
  if (v.level === 'verified') return v.stale ? { text: `Last verified ${when}; the skills have changed since`, good: false } : { text: `Verified ${when}`, good: true };
  const said: Record<string, string> = { partial: 'saw only some of the skills', 'not-listed': 'did not see the skills', unreliable: 'gave an answer that cannot be trusted', 'not-wired': 'had nothing to check', unavailable: 'could not be asked' };
  return { text: `Checked ${when}: the tool ${said[v.level] || 'did not confirm'}`, good: false };
}

export function isVerified(t: TargetReport) { return t.verification?.level === 'verified' && !t.verification.stale; }
/** Skills reach the agent: show how to call one. */
export function isWorking(t: TargetReport) { return t.feeds === 'library' || t.feeds === 'set' || (t.feeds === 'copy' && t.copy?.state === 'fresh'); }
export function needsRepoint(t: TargetReport) { return t.feeds === 'vault' || t.feeds === 'elsewhere' || t.feeds === 'broken'; }
export function needsCopy(t: TargetReport) { return t.feeds === 'needs-copy'; }
export function staleCopy(t: TargetReport) { return t.feeds === 'copy' && t.copy?.state === 'stale'; }
/** Opt-in agents are offered in the wire form, not listed as missing. */
export function unwiredNames(report: ProjectReport, planned: (targetId: string) => boolean) {
  return report.targets.filter(t => t.feeds === 'none' && !t.optIn && !planned(t.id)).map(t => AGENTS[t.id]).join(', ');
}
