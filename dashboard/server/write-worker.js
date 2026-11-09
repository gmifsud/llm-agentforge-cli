'use strict';
const { parentPort, workerData } = require('node:worker_threads');
const { WriteService } = require('./write-service');
const { ReadError, ERROR, errorDto } = require('./constants');
const service = new WriteService(workerData);
parentPort.on('message', ({ operation, args = [] }) => {
  try {
    let data;
    switch (operation) {
      case 'preview': {
        const { run, ...plan } = service.preview(args[0]); void run;
        data = plan; break;
      }
      case 'apply': data = service.apply(args[0]); break;
      default: throw new ReadError(ERROR.INVALID, 'Unknown change operation.', 400);
    }
    parentPort.postMessage({ data });
  } catch (e) { parentPort.postMessage({ failure: errorDto(e) }); }
});
