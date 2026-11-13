'use strict';
/**
 * The remembered project folders, in ~/.agentforge/projects.json. The dashboard writes it; the CLI reads it,
 * for commands that act on every project you have added.
 */
const fs = require('node:fs');
const path = require('node:path');
const { atomicWrite } = require('./paths');
const { failure } = require('../domain/errors');

function projectsFile(paths) { return path.join(paths.agentforgeDir, 'projects.json'); }

function loadSavedProjects(paths) {
  const file = projectsFile(paths);
  if (!fs.existsSync(file)) return [];
  let parsed;
  try { parsed = JSON.parse(fs.readFileSync(file, 'utf8')); } catch {
    throw failure('CONFIG_CORRUPT', `${file} is not valid JSON. Fix or move it; Agentforge will not overwrite it.`);
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

module.exports = { projectsFile, loadSavedProjects, saveSavedProjects };
