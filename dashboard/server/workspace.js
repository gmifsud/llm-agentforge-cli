'use strict';
/**
 * Dashboard-owned state that lives beside the core's files in ~/.agentforge:
 *   projects.json  remembered project folders (the CLI never reads it)
 *   config.json    "preferences" (collision winners) — read by the core's repo sync too
 * and a link-only reader for the materialized library (merged-skills).
 */
const fs = require('node:fs');
const path = require('node:path');
const { atomicWrite } = require('../../src/infra/paths');
const { failure } = require('../../src/domain/errors');

const IS_WIN = process.platform === 'win32';
const nameKey = (name) => (IS_WIN ? name.toLowerCase() : name);

function projectsFile(paths) { return path.join(paths.agentforgeDir, 'projects.json'); }

function loadSavedProjects(paths) {
  const file = projectsFile(paths);
  if (!fs.existsSync(file)) return [];
  let parsed;
  try { parsed = JSON.parse(fs.readFileSync(file, 'utf8')); } catch {
    throw failure('CONFIG_CORRUPT', `${file} is not valid JSON. Fix or move it; the dashboard will not overwrite it.`);
  }
  if (!parsed || !Array.isArray(parsed.projects) || parsed.projects.some((p) => typeof p !== 'string' || !path.isAbsolute(p))) {
    throw failure('CONFIG_INVALID', `${file} must look like {"projects": ["<absolute folder>", ...]}.`);
  }
  return parsed.projects;
}

function saveSavedProjects(paths, list) {
  fs.mkdirSync(paths.agentforgeDir, { recursive: true });
  atomicWrite(projectsFile(paths), JSON.stringify({ projects: list }, null, 2) + '\n');
}

function saveConfig(paths, config) {
  fs.mkdirSync(paths.agentforgeDir, { recursive: true });
  atomicWrite(paths.configJson, JSON.stringify(config, null, 2) + '\n');
}

function normalizeTarget(p) {
  const clean = String(p).replace(/^\\\\\?\\/, '').replace(/[\\/]+$/, '');
  const resolved = path.resolve(clean);
  return IS_WIN ? resolved.toLowerCase() : resolved;
}

/**
 * Read the materialized library without following any link.
 * Returns null when it does not exist, otherwise { builtAt, entries: Map(nameKey -> { name, target, isLink }) }.
 */
function readLibrary(dir) {
  let st;
  try { st = fs.lstatSync(dir); } catch { return null; }
  if (!st.isDirectory() || st.isSymbolicLink()) return { builtAt: st.mtime.toISOString(), entries: new Map(), invalid: true };
  const entries = new Map();
  for (const name of fs.readdirSync(dir)) {
    const p = path.join(dir, name);
    let es;
    try { es = fs.lstatSync(p); } catch { continue; }
    if (!es.isSymbolicLink()) { entries.set(nameKey(name), { name, target: null, isLink: false }); continue; }
    let target = null;
    try { target = path.resolve(dir, fs.readlinkSync(p)); } catch { /* unreadable link */ }
    entries.set(nameKey(name), { name, target, isLink: true });
  }
  return { builtAt: st.mtime.toISOString(), entries };
}

/**
 * Compare what the library should contain (computed view winners) with what is on disk.
 * winners: [{ name, absolutePath }]
 */
function diffLibrary(dir, winners) {
  const current = readLibrary(dir);
  const want = new Map(winners.map((w) => [nameKey(w.name), w]));
  const add = [], remove = [], change = [];
  if (!current) {
    return { built: false, builtAt: null, invalid: false, size: 0, add: winners.map((w) => w.name).sort(), remove, change, inSync: winners.length === 0 };
  }
  for (const [k, w] of want) {
    const have = current.entries.get(k);
    if (!have) add.push(w.name);
    else if (!have.isLink || !have.target || normalizeTarget(have.target) !== normalizeTarget(w.absolutePath)) change.push(w.name);
  }
  for (const [k, have] of current.entries) if (!want.has(k)) remove.push(have.name);
  add.sort(); remove.sort(); change.sort();
  return {
    built: true, builtAt: current.builtAt, invalid: Boolean(current.invalid), size: current.entries.size,
    add, remove, change, inSync: !current.invalid && add.length + remove.length + change.length === 0,
  };
}

module.exports = { nameKey, projectsFile, loadSavedProjects, saveSavedProjects, saveConfig, readLibrary, diffLibrary, normalizeTarget };
