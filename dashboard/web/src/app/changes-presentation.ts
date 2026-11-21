/** Only presentation preferences are persisted; queued operations and outcomes never are. */
export const CHANGES_PREFERENCE_KEY = 'agentforge.changes.presentation.v1';
export type ChangesPreference = 'compact' | 'hidden';

export function savedChangesPreference(): ChangesPreference {
  try { if (localStorage.getItem(CHANGES_PREFERENCE_KEY) === 'hidden') return 'hidden'; } catch { /* storage unavailable */ }
  return 'compact';
}

export function saveChangesPreference(value: ChangesPreference) {
  try { localStorage.setItem(CHANGES_PREFERENCE_KEY, value); } catch { /* the choice still applies for this visit */ }
}
