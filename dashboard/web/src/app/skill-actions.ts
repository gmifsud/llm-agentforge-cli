import type { Adoptable, SetAsideItem, Shadow } from '../../../contracts';

/** The plain-language lines for set aside, restore and adopt. Pure, so the wording is tested once and shown the same everywhere. */

const files = (n: number) => `${n} ${n === 1 ? 'file' : 'files'}`;

/** How a personal skill that hides a library skill differs from it. */
export function differenceText(s: Shadow): string {
  if (s.same === true) return 'The two are identical, so nothing changes in what the skill says.';
  if (s.same === null) return 'The two could not be compared.';
  const parts: string[] = [];
  if (s.personalDescription !== s.libraryDescription) parts.push('the descriptions differ');
  if (s.personalFiles !== null && s.libraryFiles !== null && s.personalFiles !== s.libraryFiles) parts.push(`yours has ${files(s.personalFiles)} and the library's has ${s.libraryFiles}`);
  return parts.length ? `Different content: ${parts.join('; ')}.` : 'Different content: the instructions or files differ.';
}

/** What adopting a folder keeps and what it adds. */
export function adoptSummary(a: Adoptable): string {
  const out: string[] = [];
  if (a.own.length) out.push(`${a.own.length} ${a.own.length === 1 ? 'skill of your own stays as it is' : 'skills of your own stay as they are'}.`);
  if (a.shared.length) out.push(`${a.shared.length} ${a.shared.length === 1 ? 'has' : 'have'} the same name as a library skill; yours is kept.`);
  out.push(a.incoming ? `${a.incoming} library ${a.incoming === 1 ? 'skill is' : 'skills are'} added beside yours.` : 'Nothing from the library is missing here.');
  return out.join(' ');
}

/** Where a set-aside skill is held, and whether it can go back. */
export function setAsideNote(i: SetAsideItem): string {
  return i.restorable ? `Held at ${i.heldAt}. Restore puts it back at ${i.from}.` : `Something is at ${i.from} now. Move it aside before restoring.`;
}
