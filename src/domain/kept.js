'use strict';

const { failure } = require('./errors');

const NAME_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const NAME_MAX = 64;
const DESCRIPTION_MAX = 900;

/** Skill names compare case-insensitively on Windows, where the filesystem does. */
const nameKey = (name) => (process.platform === 'win32' ? name.toLowerCase() : name);

const isString = (v) => typeof v === 'string';

/**
 * Why `name` cannot be a kept copy of `plain`, or null when it is fine.
 * `taken` holds nameKey()-folded names already in use. A kept name is lower-case, so it starts with `plain` lower-cased.
 */
function checkKeptName(name, plain, taken) {
  if (!isString(name) || !NAME_PATTERN.test(name)) return 'use lower-case letters, digits and single hyphens only';
  if (name.length > NAME_MAX) return `at most ${NAME_MAX} characters`;
  const prefix = `${plain.toLowerCase()}-`;
  if (!name.startsWith(prefix)) return `must start with "${prefix}"`;
  if (taken.has(nameKey(name))) return 'that name is already in use';
  return null;
}

function checkDescription(description) {
  if (!isString(description) || description.trim() === '') return 'must not be empty';
  if (/[\r\n]/.test(description)) return 'must be a single paragraph with no line breaks';
  if (description.length > DESCRIPTION_MAX) return `at most ${DESCRIPTION_MAX} characters`;
  return null;
}

/** Throws CONFIG_INVALID unless `kept` is a list of well-formed, uniquely named rules. */
function validateKept(kept, file) {
  const bad = (why) => failure('CONFIG_INVALID', `${file}: "kept" ${why}`);
  if (!Array.isArray(kept)) throw bad('must be an array');
  const taken = new Set();
  kept.forEach((rule, i) => {
    const at = `rule ${i}`;
    if (!rule || typeof rule !== 'object') throw bad(`${at} must be an object`);
    const { name, from, description, digest, keptAt } = rule;
    if (!from || !isString(from.skill) || !isString(from.source)) throw bad(`${at} needs from.skill and from.source as strings`);
    if (!isString(name)) throw bad(`${at} needs a string name`);
    const nameProblem = checkKeptName(name, from.skill, taken);
    if (nameProblem) throw bad(`${at} name "${name}": ${nameProblem}`);
    const descriptionProblem = checkDescription(description);
    if (descriptionProblem) throw bad(`${at} description ${descriptionProblem}`);
    if (digest !== null && !isString(digest)) throw bad(`${at} digest must be a string or null`);
    if (!isString(keptAt)) throw bad(`${at} needs a string keptAt`);
    taken.add(nameKey(name));
  });
}

/**
 * One entry per distinct content that differs from the winner's. `source` is the holder ranked highest in `order`;
 * `also` lists the other holders of identical content. A null digest equals nothing.
 */
function distinctOthers(candidates, order) {
  const rank = (source) => {
    const i = order.indexOf(source);
    return i === -1 ? Number.MAX_SAFE_INTEGER : i;
  };
  const winner = candidates.find((c) => c.winner);
  const winning = winner && winner.digest !== null ? winner.digest : undefined;
  const others = candidates.filter((c) => !c.winner && (c.digest === null || c.digest !== winning)).sort((a, b) => rank(a.source) - rank(b.source));
  const out = [];
  const byDigest = new Map();
  for (const c of others) {
    const existing = c.digest === null ? undefined : byDigest.get(c.digest);
    if (existing) { existing.also.push(c.source); continue; }
    const entry = { source: c.source, also: [], digest: c.digest };
    out.push(entry);
    if (c.digest !== null) byDigest.set(c.digest, entry);
  }
  return out;
}

module.exports = { validateKept, checkKeptName, checkDescription, distinctOthers, nameKey };
