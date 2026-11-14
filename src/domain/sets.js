'use strict';
/**
 * Skill sets: the rules, with no filesystem in sight.
 *
 * A set is an ordered list of rules over the library. A rule selects skills by one of four things:
 *   skill     one skill, by name (what you pick by hand)
 *   name      a pattern over names, with * and ? (orcaflex-*)
 *   source    every skill the library took from one source ("vault" is your primary vault)
 *   category  every skill whose own `category` says so
 * An include rule adds what it selects; an exclude rule removes it; the last rule that touches a skill wins.
 * Resolving a set against the library gives plain skill names. Nothing is stored except the rules.
 */
const { usage } = require('./errors');

const RULE_TYPES = ['skill', 'name', 'source', 'category'];
const RESERVED = new Set(['library', 'vault', 'merged-skills']);
const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const lc = (s) => String(s ?? '').toLowerCase();
const byName = (a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0);

/** A set's name is also a folder name, so it is kept to letters, digits and . _ - and never the library's own names. */
function validateSetName(name) {
  if (typeof name !== 'string' || !NAME_RE.test(name)) {
    throw usage(`"${name ?? ''}" cannot be a set name. Use letters, digits, "-", "_" or "." (not first), up to 64 characters.`);
  }
  if (RESERVED.has(name.toLowerCase())) throw usage(`"${name}" is reserved. Choose another name for the set.`);
  return name;
}

/** `category:offshore-engineering` becomes a rule. Only the first colon separates the type from the value. */
function parseRule(text, { exclude = false } = {}) {
  const raw = String(text ?? '');
  const i = raw.indexOf(':');
  if (i <= 0) throw usage(`rule "${raw.trim()}" must look like type:value, for example category:offshore-engineering`);
  const type = raw.slice(0, i).trim().toLowerCase();
  const value = raw.slice(i + 1).trim();
  if (!RULE_TYPES.includes(type)) throw usage(`"${type}" is not a kind of rule. Use skill, name, source or category`);
  if (!value) throw usage(`rule ${type}: needs a value`);
  return exclude ? { type, value, exclude: true } : { type, value };
}

/** A stored set, checked. Throws a plain Error naming what is wrong; the store turns it into a config error. */
function normaliseSet(raw) {
  if (!raw || !Array.isArray(raw.rules)) throw new Error('a set needs a "rules" list');
  const rules = raw.rules.map((r, i) => {
    if (!r || !RULE_TYPES.includes(r.type)) throw new Error(`rule ${i + 1} has an unknown type; use ${RULE_TYPES.join(', ')}`);
    if (typeof r.value !== 'string' || !r.value.trim()) throw new Error(`rule ${i + 1} needs a value`);
    return r.exclude === true ? { type: r.type, value: r.value.trim(), exclude: true } : { type: r.type, value: r.value.trim() };
  });
  return { rules };
}

/** * matches any run of characters and ? one character; everything else is literal. Case does not matter; the whole name must match. */
function globToRegExp(pattern) {
  const body = String(pattern).replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.');
  return new RegExp(`^${body}$`, 'i');
}

function matches(rule, entry) {
  switch (rule.type) {
    case 'skill': return lc(entry.name) === lc(rule.value);
    case 'name': return globToRegExp(rule.value).test(entry.name);
    case 'source': return lc(entry.source) === lc(rule.value);
    case 'category': return lc(entry.category) === lc(rule.value);
    default: return false;
  }
}

/**
 * Resolve a set against the library: entries `{ name, source, category, absolutePath, ... }`, one per skill, each the
 * winner the library already chose. Returns
 *   entries    the skills in the set, in name order (the same whichever way `library` was listed)
 *   rules      each rule with how many skills it selected (matched), newly added or newly removed
 *   unmatched  include rules that selected nothing, so a typo is never saved quietly
 */
function resolveSet(set, library) {
  const sorted = [...library].sort(byName);
  const chosen = new Map();
  const info = [];
  for (const rule of set.rules) {
    const hit = sorted.filter((e) => matches(rule, e));
    let added = 0, removed = 0;
    for (const e of hit) {
      const key = lc(e.name);
      if (rule.exclude) { if (chosen.delete(key)) removed++; } else if (!chosen.has(key)) { chosen.set(key, e); added++; }
    }
    info.push({ ...rule, matched: hit.length, added, removed });
  }
  return {
    entries: [...chosen.values()].sort(byName),
    rules: info,
    unmatched: info.filter((r) => !r.exclude && r.matched === 0).map(({ type, value }) => ({ type, value })),
  };
}

module.exports = { RULE_TYPES, validateSetName, parseRule, normaliseSet, globToRegExp, matches, resolveSet };
