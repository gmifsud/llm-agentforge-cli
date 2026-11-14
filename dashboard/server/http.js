'use strict';
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { Reader } = require('./reader');
const { contained } = require('./read-service');
const { API, API_HEADER, API_HEADER_VALUE, WRITE_HEADER, WRITE_ROUTES, HOST, ERROR, LIMITS, ReadError, errorDto } = require('./constants');

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.ico': 'image/x-icon', '.png': 'image/png', '.svg': 'image/svg+xml', '.woff2': 'font/woff2' };
const CLIENT_ROUTES = new Set(['/', '/library', '/map', '/fleet', '/sets']);

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', c => { size += c.length; if (size > LIMITS.bodyBytes) { reject(new ReadError(ERROR.INVALID, 'Request body is too large.', 413)); req.destroy(); } else chunks.push(c); });
    req.on('end', () => { try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || 'null')); } catch { reject(new ReadError(ERROR.INVALID, 'Request body must be JSON.', 400)); } });
    req.on('error', () => reject(new ReadError(ERROR.INVALID, 'Request body could not be read.', 400)));
  });
}

async function createDashboard({ options, assetRoot = path.resolve(__dirname, '../web/dist/browser'), port = 0, devOrigin, reader = new Reader(options),
  writer = new Reader(options, { workerFile: path.join(__dirname, 'write-worker.js'), timeoutMs: LIMITS.writeMs }) } = {}) {
  if (devOrigin && !/^http:\/\/127\.0\.0\.1:\d+$/.test(devOrigin)) throw new Error('Development origin must be a loopback HTTP origin.');
  const server = http.createServer(async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; object-src 'none'");
    const json = (status, data) => { res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(req.method === 'HEAD' ? undefined : JSON.stringify(data)); };
    try {
      const host = `${HOST}:${server.address().port}`, origin = `http://${host}`;
      if (req.headers.host !== host || (req.headers.origin && req.headers.origin !== origin && req.headers.origin !== devOrigin) || req.headers['sec-fetch-site'] === 'cross-site') {
        throw new ReadError(ERROR.BOUNDARY, 'Only this local dashboard origin is allowed.', 403);
      }
      const rawPath = (req.url || '/').split('?')[0];
      if (req.method === 'POST' && Object.hasOwn(WRITE_ROUTES, rawPath)) {
        // Writes: same origin only, Origin required (browsers always send it on POST), two custom headers, JSON, bounded.
        if (req.headers.origin !== origin && !(devOrigin && req.headers.origin === devOrigin)) throw new ReadError(ERROR.BOUNDARY, 'Changes must come from this dashboard page.', 403);
        if (req.headers['sec-fetch-site'] && req.headers['sec-fetch-site'] !== 'same-origin') throw new ReadError(ERROR.BOUNDARY, 'Changes must come from this dashboard page.', 403);
        if (req.headers[API_HEADER] !== API_HEADER_VALUE || req.headers[WRITE_HEADER] !== '1') throw new ReadError(ERROR.BOUNDARY, 'The dashboard change header is required.', 403);
        if (!/^application\/json(;|$)/i.test(req.headers['content-type'] || '')) throw new ReadError(ERROR.INVALID, 'Changes must be sent as JSON.', 415);
        if ((req.url || '').includes('?')) throw new ReadError(ERROR.INVALID, 'Unsupported query parameter.', 400);
        const body = await readBody(req);
        const operation = WRITE_ROUTES[rawPath];
        const arg = operation === 'preview' ? body?.change : body?.changes;
        json(200, await writer.run(operation, [arg]));
        return;
      }
      if (!['GET', 'HEAD'].includes(req.method)) { res.setHeader('Allow', 'GET, HEAD'); throw new ReadError(ERROR.METHOD, 'Use GET for reads; changes go through /api/v1/changes.', 405); }
      let decoded;
      try { decoded = decodeURIComponent(rawPath); } catch { throw new ReadError(ERROR.INVALID, 'Invalid URL encoding.', 400); }
      if (!decoded.startsWith('/') || decoded.includes('\\') || decoded.includes('\0') || decoded.split('/').some(s => s === '..' || s === '.')) {
        throw new ReadError(ERROR.BOUNDARY, 'Path traversal is not allowed.', 403);
      }
      const url = new URL(req.url, origin);
      if (decoded.startsWith('/api/')) {
        if (req.headers[API_HEADER] !== API_HEADER_VALUE) throw new ReadError(ERROR.BOUNDARY, 'The dashboard read header is required.', 403);
        let operation, args = [];
        if (decoded === `${API}/context`) operation = 'context';
        else if (decoded === `${API}/catalog`) operation = 'catalog';
        else {
          const doc = decoded.match(/^\/api\/v1\/skills\/([a-f0-9]{64})\/document$/);
          const project = decoded.match(/^\/api\/v1\/projects\/([a-f0-9]{64})$/);
          const cmp = decoded.match(/^\/api\/v1\/skills\/([a-f0-9]{64})\/compare\/([a-f0-9]{64})$/);
          if (doc) { operation = 'document'; args = [doc[1], url.searchParams.get('generation')]; }
          else if (cmp) { operation = 'compare'; args = [cmp[1], cmp[2], url.searchParams.get('generation')]; }
          else if (project) { operation = 'project'; args = [project[1]]; }
          else throw new ReadError(ERROR.NOT_FOUND, 'Read endpoint not found.', 404);
        }
        if ([...url.searchParams.keys()].some(k => !['document', 'compare'].includes(operation) || k !== 'generation')) throw new ReadError(ERROR.INVALID, 'Unsupported query parameter.', 400);
        if (req.method === 'HEAD') { res.writeHead(204); res.end(); return; }
        json(200, await reader.run(operation, args)); return;
      }
      const filename = CLIENT_ROUTES.has(decoded) || /^\/compare\/[^/]+$/.test(decoded) || /^\/sets\/[^/]+$/.test(decoded) ? 'index.html' : decoded.slice(1);
      const file = path.resolve(assetRoot, filename);
      contained(assetRoot, file);
      const mime = MIME[path.extname(file)];
      if (!mime) throw new ReadError(ERROR.NOT_FOUND, 'Asset not found.', 404);
      let data;
      try { data = await fs.promises.readFile(file); } catch { throw new ReadError(ERROR.NOT_FOUND, 'Dashboard assets are missing. Run the dashboard build first.', 404); }
      res.writeHead(200, { 'Content-Type': mime }); res.end(req.method === 'HEAD' ? undefined : data);
    } catch (e) {
      const failure = errorDto(e);
      if (failure.status === 500) console.error('Dashboard read failed:', e);
      json(failure.status, { error: failure.error });
    }
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, HOST, resolve); });
  return { server, url: `http://${HOST}:${server.address().port}`, async close() {
    const closing = new Promise(resolve => server.close(resolve));
    server.closeAllConnections(); await reader.close(); await writer.close(); await closing;
  } };
}
module.exports = { createDashboard };
