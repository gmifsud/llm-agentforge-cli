'use strict';

const fs = require('node:fs');
const path = require('node:path');

/**
 * Rules a SKILL.md must meet to be invocable, and which agent tools each rule
 * matters to. Sources (checked 2026-11-11): Claude Code, Codex, Gemini CLI and
 * Cursor skills documentation; see docs/DASHBOARD.md and the options note.
 *
 * severity: 'error' = the skill will not load or be callable in the listed tools
 *           'warn'  = it loads but degrades (trimmed, or chosen less reliably)
 *           'info'  = deliberate author setting worth knowing about
 */
const DESCRIPTION_CAP = 1536; // Claude Code listing cap for description + when_to_use
const NAME_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/**
 * Minimal YAML frontmatter reader: `key: value`, quoted values, and `|` / `>`
 * block scalars. Frontmatter must open on line 1. Returns { fields, body };
 * fields is null when there is no frontmatter.
 */
function parseFrontmatter(text) {
  const src = String(text).replace(/^﻿/, '');
  const lines = src.split(/\r?\n/);
  if (lines[0] !== '---') return { fields: null, body: src };
  const end = lines.indexOf('---', 1);
  if (end === -1) return { fields: null, body: src };
  const fields = {};
  for (let i = 1; i < end; i++) {
    const m = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(lines[i]);
    if (!m) continue;
    const key = m[1];
    let value = m[2].trim();
    if (/^[|>][+-]?$/.test(value)) {
      const folded = value[0] === '>';
      const block = [];
      while (i + 1 < end && (/^\s+/.test(lines[i + 1]) || lines[i + 1] === '')) block.push(lines[++i].replace(/^\s+/, ''));
      while (block.length && block[block.length - 1] === '') block.pop();
      value = folded ? block.join(' ').replace(/\s+/g, ' ').trim() : block.join('\n');
    } else if ((value.startsWith('"') && value.endsWith('"') && value.length > 1) || (value.startsWith("'") && value.endsWith("'") && value.length > 1)) {
      value = value.slice(1, -1);
    }
    fields[key] = value;
  }
  return { fields, body: lines.slice(end + 1).join('\n') };
}

const finding = (code, severity, tools, message) => ({ code, severity, tools, message });

/**
 * Lint one skill folder. Returns { name, description, fields, findings }.
 * Reads only <dir>/SKILL.md.
 */
function lintSkill(dir) {
  const folder = path.basename(path.resolve(dir));
  const file = path.join(dir, 'SKILL.md');
  let text;
  try { text = fs.readFileSync(file, 'utf8'); } catch {
    return { name: folder, description: '', fields: null, findings: [finding('NO_SKILL_MD', 'error', ['claude', 'codex', 'gemini', 'cursor'], `${folder} has no readable SKILL.md`)] };
  }
  const { fields } = parseFrontmatter(text);
  const findings = [];
  if (!fields) {
    findings.push(finding('NO_FRONTMATTER', 'error', ['codex', 'gemini', 'cursor'],
      `${folder}: SKILL.md has no frontmatter on line 1. Claude Code falls back to the folder name; the other tools need name and description.`));
    return { name: folder, description: '', fields: null, findings };
  }
  const name = fields.name;
  const description = fields.description || '';
  if (!name) {
    findings.push(finding('NAME_MISSING', 'error', ['codex', 'gemini', 'cursor'], `${folder}: frontmatter has no name. Claude Code uses the folder name; the other tools require it.`));
  } else if (name !== folder) {
    findings.push(finding('NAME_MISMATCH', 'error', ['cursor', 'gemini'], `${folder}: name is "${name}" but the folder is "${folder}". Cursor requires them to match, and Gemini expects it.`));
  } else if (!NAME_RE.test(name)) {
    findings.push(finding('NAME_CHARSET', 'error', ['cursor'], `${folder}: name must be lowercase letters, digits and hyphens for Cursor.`));
  }
  if (!description) {
    findings.push(finding('DESCRIPTION_MISSING', 'warn', ['claude', 'codex', 'gemini', 'cursor'], `${folder}: no description, so an agent cannot tell when to use it.`));
  } else if (description.length + (fields.when_to_use || '').length > DESCRIPTION_CAP) {
    findings.push(finding('DESCRIPTION_LONG', 'warn', ['claude'], `${folder}: description is over ${DESCRIPTION_CAP} characters and will be cut in Claude Code's listing.`));
  }
  if (/^false$/i.test(fields['user-invocable'] || '')) {
    findings.push(finding('NOT_USER_INVOCABLE', 'info', ['claude'], `${folder}: user-invocable is false, so it is hidden from the / menu in Claude Code.`));
  }
  if (/^true$/i.test(fields['disable-model-invocation'] || '')) {
    findings.push(finding('MODEL_INVOCATION_OFF', 'info', ['claude', 'cursor'], `${folder}: the agent will not use it on its own; it only runs when you call it.`));
  }
  return { name: name || folder, description, fields, findings };
}

/**
 * Skills at another level that have the same name as a linked skill and take
 * precedence over it (for example a personal ~/.claude/skills/<name>).
 * levels: [{ tool, level, dir }]. Only folders that hold a SKILL.md count.
 */
function findShadows(names, levels) {
  const wanted = new Set(names);
  const out = [];
  for (const lvl of levels) {
    let entries;
    try { entries = fs.readdirSync(lvl.dir); } catch { continue; }
    for (const entry of entries) {
      if (!wanted.has(entry)) continue;
      const p = path.join(lvl.dir, entry);
      if (fs.existsSync(path.join(p, 'SKILL.md'))) out.push({ name: entry, tool: lvl.tool, level: lvl.level, path: p });
    }
  }
  return out;
}

/** Personal-level skill folders that override or sit beside project skills, per tool. */
function personalLevels(homedir) {
  return [
    { tool: 'claude', level: 'personal', dir: path.join(homedir, '.claude', 'skills') },
    { tool: 'codex', level: 'personal', dir: path.join(homedir, '.agents', 'skills') },
    { tool: 'gemini', level: 'personal', dir: path.join(homedir, '.gemini', 'skills') },
    { tool: 'cursor', level: 'personal', dir: path.join(homedir, '.cursor', 'skills') },
  ];
}

module.exports = { parseFrontmatter, lintSkill, findShadows, personalLevels, DESCRIPTION_CAP };
