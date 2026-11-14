'use strict';
/**
 * Setting aside a personal skill that hides a library skill of the same name.
 *
 * The personal folder is MOVED, whole, to ~/.agentforge/set-aside/<tool>/<name>, and a record of where it
 * came from is written beside it (never inside it, so the skill folder gains no file). Nothing is deleted
 * and nothing is copied: if the move cannot be a plain rename (another drive), it is refused.
 * Restore moves it back, and only to the place worked out from the tool and the name, never from the record.
 */
const fs = require('node:fs');
const path = require('node:path');
const { personalLevels } = require('../discovery/skill-lint');
const { inspectDestination } = require('../infra/fs-inspect');
const { refused } = require('../domain/errors');

const SAFE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

const levelFor = (paths, tool) => personalLevels(paths.homedir).find(l => l.tool === tool);
const recordFile = (paths, tool, name) => path.join(paths.setAsideDir, tool, `${name}.json`);
const heldAt = (paths, tool, name) => path.join(paths.setAsideDir, tool, name);

function check(paths, tool, name) {
  const conflicts = [];
  const level = levelFor(paths, tool);
  if (!level) conflicts.push(`Unknown tool "${tool}".`);
  if (typeof name !== 'string' || !SAFE_NAME.test(name) || name.includes('..')) conflicts.push(`${JSON.stringify(name)} is not a valid skill name.`);
  return { level, conflicts };
}

/** Read-only. libraryNames: the names the library holds, so only a skill that really hides one is moved. */
function planSetAside({ paths, tool, name, libraryNames }) {
  const { level, conflicts } = check(paths, tool, name);
  if (conflicts.length) return { ok: false, conflicts, from: null, to: null };
  const from = path.join(level.dir, name);
  const to = heldAt(paths, tool, name);
  if (!fs.existsSync(path.join(from, 'SKILL.md'))) conflicts.push(`No personal ${tool} skill called "${name}" at ${from}.`);
  else if (!libraryNames.includes(name)) conflicts.push(`"${name}" does not hide a library skill, so there is nothing to set aside.`);
  if (inspectDestination(to).kind !== 'missing' || fs.existsSync(recordFile(paths, tool, name))) conflicts.push(`${path.join(paths.setAsideDir, tool)} already holds a set-aside ${name}. Restore or move that one first.`);
  return { ok: conflicts.length === 0, conflicts, tool, name, from, to };
}

function applySetAside(plan, { now = new Date() } = {}) {
  if (!plan.ok) throw refused('PLAN_CONFLICTS', plan.conflicts.join(' '));
  const rec = path.join(path.dirname(plan.to), `${plan.name}.json`);
  if (inspectDestination(plan.to).kind !== 'missing' || fs.existsSync(rec)) throw refused('STALE_PLAN', `${plan.to} appeared since planning`);
  if (!fs.existsSync(path.join(plan.from, 'SKILL.md'))) throw refused('STALE_PLAN', `${plan.from} is no longer a skill`);
  fs.mkdirSync(path.dirname(plan.to), { recursive: true });
  // The record first: a move that fails leaves nothing behind but a file we remove, and a move that works is never unrecorded.
  fs.writeFileSync(rec, JSON.stringify({ tool: plan.tool, name: plan.name, from: plan.from, at: now.toISOString() }, null, 2) + '\n', { encoding: 'utf8', flag: 'wx' });
  try { fs.renameSync(plan.from, plan.to); }
  catch (e) {
    fs.rmSync(rec, { force: true });
    if (e.code === 'EXDEV') throw refused('CROSS_DEVICE', `${plan.from} is on another drive from ${plan.to}. It was not moved: Agentforge never copies and deletes your files.`);
    throw e;
  }
  return { from: plan.from, to: plan.to };
}

/** Everything set aside, read from the records, with whether it can go back now. */
function listSetAside(paths) {
  const out = [];
  let tools; try { tools = fs.readdirSync(paths.setAsideDir); } catch { return out; }
  for (const tool of tools.sort()) {
    let files; try { files = fs.readdirSync(path.join(paths.setAsideDir, tool)); } catch { continue; }
    for (const file of files.sort()) {
      if (!file.endsWith('.json')) continue;
      const name = file.slice(0, -5);
      let rec; try { rec = JSON.parse(fs.readFileSync(path.join(paths.setAsideDir, tool, file), 'utf8')); } catch { continue; }
      const plan = planRestore({ paths, tool, name });
      out.push({ tool, name, at: typeof rec.at === 'string' ? rec.at : null, from: plan.to, heldAt: plan.from, restorable: plan.ok });
    }
  }
  return out;
}

/** Read-only. The place it goes back to comes from the tool and the name, never from the record. */
function planRestore({ paths, tool, name }) {
  const { level, conflicts } = check(paths, tool, name);
  if (conflicts.length) return { ok: false, conflicts, from: null, to: null };
  const from = heldAt(paths, tool, name);
  const to = path.join(level.dir, name);
  if (!fs.existsSync(path.join(from, 'SKILL.md'))) conflicts.push(`Nothing is set aside as ${name} for ${tool}.`);
  if (inspectDestination(to).kind !== 'missing') conflicts.push(`There is already a skill at ${to}. Move or set aside that one first.`);
  return { ok: conflicts.length === 0, conflicts, tool, name, from, to };
}

function applyRestore(plan) {
  if (!plan.ok) throw refused('PLAN_CONFLICTS', plan.conflicts.join(' '));
  if (inspectDestination(plan.to).kind !== 'missing') throw refused('STALE_PLAN', `${plan.to} appeared since planning`);
  fs.mkdirSync(path.dirname(plan.to), { recursive: true });
  try { fs.renameSync(plan.from, plan.to); }
  catch (e) {
    if (e.code === 'EXDEV') throw refused('CROSS_DEVICE', `${plan.from} is on another drive from ${plan.to}. It was not moved.`);
    throw e;
  }
  fs.rmSync(path.join(path.dirname(plan.from), `${plan.name}.json`), { force: true });
  return { from: plan.from, to: plan.to };
}

module.exports = { planSetAside, applySetAside, planRestore, applyRestore, listSetAside };
