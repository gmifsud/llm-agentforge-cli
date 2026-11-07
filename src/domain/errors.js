'use strict';

/**
 * Structured error for the agentforge core.
 * The core never calls process.exit(); the CLI maps exitCode.
 *   1 = failure, 2 = usage, 3 = refused (conflict / safety boundary)
 */
class AgentforgeError extends Error {
  constructor(code, message, { exitCode = 1, details } = {}) {
    super(message);
    this.name = 'AgentforgeError';
    this.code = code;
    this.exitCode = exitCode;
    if (details !== undefined) this.details = details;
  }
}

const usage = (message) => new AgentforgeError('USAGE', message, { exitCode: 2 });
const refused = (code, message, details) => new AgentforgeError(code, message, { exitCode: 3, details });
const failure = (code, message, details) => new AgentforgeError(code, message, { exitCode: 1, details });

module.exports = { AgentforgeError, usage, refused, failure };
