'use strict';

const LIMITS = Object.freeze({ documentBytes: 1024 * 1024, revisionHeadBytes: 4096, revisionRefsBytes: 1024 * 1024, jobMs: 15000, candidates: 5000 });
const API = '/api/v1';
const API_HEADER = 'x-agentforge-read';
const API_HEADER_VALUE = '1';
const HOST = '127.0.0.1';
const ERROR = Object.freeze({
  INVALID: 'INVALID_REQUEST', BOUNDARY: 'READ_BOUNDARY', NOT_FOUND: 'NOT_FOUND', STALE: 'STALE_CATALOG',
  LARGE: 'DOCUMENT_TOO_LARGE', LIMIT: 'CATALOG_LIMIT', BUSY: 'BUSY', TIMEOUT: 'READ_TIMEOUT',
  UNAVAILABLE: 'UNAVAILABLE', CHANGED: 'FILE_CHANGED', INTERNAL: 'INTERNAL_ERROR', METHOD: 'METHOD_NOT_ALLOWED',
});
class ReadError extends Error {
  constructor(code, message, status = 503) { super(message); this.code = code; this.status = status; }
}
function errorDto(error) {
  const known = error instanceof ReadError;
  return { status: known ? error.status : 500, error: {
    code: known ? error.code : ERROR.INTERNAL,
    message: known ? error.message : 'The local read failed. Check the adapter console.',
    retryable: known && [503, 504, 409].includes(error.status),
  } };
}
module.exports = { LIMITS, API, API_HEADER, API_HEADER_VALUE, HOST, ERROR, ReadError, errorDto };
