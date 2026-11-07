'use strict';

const { execFileSync } = require('node:child_process');
const { failure, usage } = require('../domain/errors');
const { isGitUrl } = require('../domain/source-id');

/**
 * All git calls go through here: executable + argument array, never a shell string.
 * `runner` is injectable for tests.
 */
function createGit({ runner = defaultRunner } = {}) {
  function run(args, { cwd } = {}) {
    try {
      return runner(args, { cwd });
    } catch (e) {
      const stderr = e.stderr ? String(e.stderr).trim() : '';
      throw failure('GIT_FAILED', `git ${args[0]} failed${stderr ? `: ${stderr.split('\n').pop()}` : `: ${e.message}`}`);
    }
  }

  return {
    clone(url, dest, branch) {
      if (!isGitUrl(url)) throw usage(`unsupported git URL "${url}" (expected https://, ssh:// or git@host:path)`);
      if (typeof dest !== 'string' || dest.startsWith('-')) throw usage('invalid clone destination');
      const args = [
        '-c', 'core.hooksPath=.agentforge-no-hooks', // never run checkout hooks from a fetched source
        'clone', '--depth', '1', '--no-recurse-submodules',
      ];
      if (branch) {
        if (branch.startsWith('-')) throw usage(`invalid branch "${branch}"`);
        args.push('--branch', branch);
      }
      args.push('--', url, dest);
      return run(args);
    },
    pull(dir) {
      return run(['-c', 'core.hooksPath=.agentforge-no-hooks', 'pull', '--ff-only'], { cwd: dir });
    },
    revision(dir) {
      try { return run(['rev-parse', '--short', 'HEAD'], { cwd: dir }).trim(); } catch { return undefined; }
    },
  };
}

function defaultRunner(args, { cwd }) {
  return execFileSync('git', args, {
    cwd,
    shell: false,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    maxBuffer: 8 * 1024 * 1024,
  });
}

module.exports = { createGit };
