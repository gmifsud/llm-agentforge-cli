'use strict';
const path = require('node:path');
const { Worker } = require('node:worker_threads');
const { ERROR, LIMITS, ReadError } = require('./constants');

/** One session worker; no queue. Only identical catalogue refreshes coalesce. */
class Reader {
  constructor(options, { timeoutMs = LIMITS.jobMs, workerFile = path.join(__dirname, 'read-worker.js') } = {}) {
    this.options = options; this.timeoutMs = timeoutMs; this.workerFile = workerFile;
    this.worker = null; this.pending = null; this.closed = false;
  }
  run(operation, args = []) {
    if (this.closed) return Promise.reject(new ReadError(ERROR.UNAVAILABLE, 'The local session is closed.'));
    if (this.pending) {
      if (operation === 'catalog' && this.pending.operation === operation) return this.pending.promise;
      return Promise.reject(new ReadError(ERROR.BUSY, 'Another local read is running. Try again.'));
    }
    if (!this.worker) {
      const created = new Worker(this.workerFile, { workerData: this.options });
      this.worker = created;
      // Keep lifecycle listeners while idle, after per-job handlers are removed.
      const discard = () => { if (this.worker === created) this.worker = null; };
      created.on('error', discard);
      created.on('exit', discard);
    }
    const worker = this.worker;
    let resolve, reject;
    const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
    const cleanup = () => {
      clearTimeout(timer); worker.off('message', onMessage); worker.off('error', onError); worker.off('exit', onExit); this.pending = null;
    };
    const onMessage = result => { cleanup(); if (result.failure) reject(new ReadError(result.failure.error.code, result.failure.error.message, result.failure.status)); else resolve(result.data); };
    const fail = error => { cleanup(); this.worker = null; void worker.terminate(); reject(error); };
    const onError = () => fail(new ReadError(ERROR.UNAVAILABLE, 'The read worker failed. Refresh and retry.'));
    const onExit = () => fail(new ReadError(ERROR.UNAVAILABLE, 'The read worker stopped. Refresh and retry.'));
    const timer = setTimeout(() => fail(new ReadError(ERROR.TIMEOUT, 'The local read timed out. Refresh and retry.', 504)), this.timeoutMs);
    this.pending = { operation, promise, cancel: () => fail(new ReadError(ERROR.UNAVAILABLE, 'The local session is closing.')) };
    worker.once('message', onMessage); worker.once('error', onError); worker.once('exit', onExit);
    worker.postMessage({ operation, args });
    return promise;
  }
  async close() {
    this.closed = true;
    const worker = this.worker;
    this.pending?.cancel();
    this.worker = null;
    if (worker) await worker.terminate();
  }
}
module.exports = { Reader };
