'use strict';
const { parentPort, workerData } = require('node:worker_threads');
const { ReadService } = require('./read-service');
const { ReadError, ERROR, errorDto } = require('./constants');
const service = new ReadService(workerData);
parentPort.on('message', ({ operation, args = [] }) => {
  try {
    let data;
    switch (operation) {
      case 'context': data = service.context(); break;
      case 'catalog': data = service.refresh(); break;
      case 'document': data = service.document(...args); break;
      case 'project': data = service.project(...args); break;
      default: throw new ReadError(ERROR.INVALID, 'Unknown read operation.', 400);
    }
    parentPort.postMessage({ data });
  } catch (e) { parentPort.postMessage({ failure: errorDto(e) }); }
});
