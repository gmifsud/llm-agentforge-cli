'use strict';
const { parentPort, workerData } = require('node:worker_threads');
const { SuggestService } = require('./suggest-service');
const { ReadError, ERROR, errorDto } = require('./constants');
const service = new SuggestService(workerData);
parentPort.on('message', ({ operation, args = [] }) => {
  try {
    if (operation !== 'suggest') throw new ReadError(ERROR.INVALID, 'Unknown suggestion operation.', 400);
    parentPort.postMessage({ data: service.suggest(args[0], args[1], { fresh: args[2] === true }) });
  } catch (e) { parentPort.postMessage({ failure: errorDto(e) }); }
});
