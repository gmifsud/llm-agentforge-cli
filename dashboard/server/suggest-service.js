'use strict';
/**
 * Name and description suggestions for the copies of a clashing skill that are not the main one.
 * A suggestion costs a model call on the owner's account, so answers are cached by content: the same pair of
 * copies is never asked about twice. Runs in its own worker pool, never in the write worker.
 */
const fs = require('node:fs');
const path = require('node:path');
const { atomicWrite } = require('../../src/infra/paths');
const { distinctOthers, checkKeptName, checkDescription, nameKey } = require('../../src/domain/kept');
const { digestSkill } = require('../../src/discovery/skill-digest');
const { suggestKeep } = require('../../src/application/suggest');
const { WriteService } = require('./write-service');
const { readPlainFile } = require('./read-service');
const { ReadError, ERROR, LIMITS } = require('./constants');

const MODEL_PATTERN = /^[A-Za-z0-9._-]{1,64}$/;
const DEFAULT_MODEL = 'sonnet';
const MAX_COPIES = 5;   // the most copies one request is sized for

/** The model from config.suggestModel when it is a plain model name (never one that reads as a flag), otherwise the default. */
const modelFrom = (config) => (typeof config.suggestModel === 'string' && MODEL_PATTERN.test(config.suggestModel) && !config.suggestModel.startsWith('-') ? config.suggestModel : DEFAULT_MODEL);

class SuggestService {
  constructor(options = {}) {
    this.run = options.run;   // injected in tests; the real one starts the claude CLI
    this.writer = new WriteService(options);   // only for its view of the library, kept rules included
    this.paths = this.writer.paths;
    this.cacheFile = path.join(this.paths.agentforgeDir, 'suggestions.json');
  }

  /** The cache as a plain object; anything damaged counts as empty. */
  readCache() {
    try {
      const parsed = JSON.parse(fs.readFileSync(this.cacheFile, 'utf8'));
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
    } catch { return {}; }
  }
  writeCache(additions) {
    const merged = { ...this.readCache(), ...additions };   // re-read so the other worker's entries survive
    fs.mkdirSync(this.paths.agentforgeDir, { recursive: true });
    atomicWrite(this.cacheFile, JSON.stringify(merged, null, 2) + '\n');
  }

  /** SKILL.md text and relative file list of one copy; an unreadable copy gives empty text and no files. */
  describeCopy(candidate) {
    const dir = candidate.absolutePath;
    let text = '', files = [];
    try { text = readPlainFile(dir, path.join(dir, 'SKILL.md')); } catch { /* unreadable: the model sees no text */ }
    try { files = digestSkill(dir).files.map(f => f.path); } catch { /* too large or unreadable */ }
    return { source: candidate.source, text, files };
  }

  /** One suggestion per distinct copy other than `main`. `fresh` ignores the cache. */
  suggest(skill, main, { fresh = false } = {}) {
    const config = this.writer.config();
    const view = this.writer.viewFor(config);
    const clash = view.clashes.find(c => nameKey(c.name) === nameKey(skill));
    if (!clash) throw new ReadError(ERROR.INVALID, `Only one source provides "${skill}", so there is nothing to name.`, 400);
    const mainCopy = clash.candidates.find(c => c.source === main);
    if (!mainCopy) throw new ReadError(ERROR.INVALID, `"${main}" does not provide "${clash.name}".`, 400);
    const plain = clash.name;
    const rows = distinctOthers(clash.candidates.map(c => ({ source: c.source, digest: c.digest, winner: c.source === main })), view.order);
    const model = modelFrom(config);
    // Every name in use now, kept rules included; it grows as suggestions are handed out so no two collide.
    const taken = new Set([...view.entries.map(e => nameKey(e.name)), ...(config.kept || []).map(r => nameKey(r.name))]);
    const mainText = this.describeCopy(mainCopy);
    const cache = this.readCache(), additions = {};
    const suggestions = rows.map(row => {
      const key = `${nameKey(plain)}|${row.source}|${mainCopy.digest}|${row.digest}`;
      const hit = cache[key];
      if (!fresh && mainCopy.digest && row.digest && hit && !checkKeptName(hit.name, plain, taken) && !checkDescription(hit.description)) {
        taken.add(nameKey(hit.name));
        return { source: row.source, name: hit.name, description: hit.description, difference: String(hit.difference || ''), by: 'cache' };
      }
      const other = this.describeCopy(clash.candidates.find(c => c.source === row.source));
      const result = suggestKeep({ plain, main: mainText, other, taken, model, ...(this.run ? { run: this.run } : {}) });
      taken.add(nameKey(result.name));
      // Only a real answer is worth keeping; a fallback is cheap and should retry once claude is available.
      if (result.by === 'claude' && mainCopy.digest && row.digest) additions[key] = { name: result.name, description: result.description, difference: result.difference };
      return { source: row.source, name: result.name, description: result.description, difference: result.difference, by: result.by };
    });
    if (Object.keys(additions).length) { try { this.writeCache(additions); } catch { /* a cache that cannot be written only costs a repeat call */ } }
    return { suggestions };
  }
}

/** Two suggesters at most work at once; a request that finds both busy is told to retry. */
class SuggestPool {
  constructor(suggesters) { this.members = suggesters.map(s => ({ s, busy: false })); }
  async run(operation, args) {
    const member = this.members.find(m => !m.busy);
    if (!member) throw new ReadError(ERROR.BUSY, 'Two suggestions are already running. Try again shortly.', 503);
    member.busy = true;
    try { return await member.s.run(operation, args); } finally { member.busy = false; }
  }
  async close() { await Promise.all(this.members.map(m => m.s.close())); }
}

/** Longest a worker may take: every copy at the per-copy limit, plus a margin. */
const suggestTimeoutMs = (copies = MAX_COPIES) => LIMITS.suggestCopyMs * copies + 10000;

module.exports = { SuggestService, SuggestPool, suggestTimeoutMs, modelFrom };
