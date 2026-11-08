'use strict';
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { Reader } = require('./reader');
const { contained } = require('./read-service');
const { API, API_HEADER, API_HEADER_VALUE, HOST, ERROR, ReadError, errorDto } = require('./constants');

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.ico': 'image/x-icon', '.png': 'image/png', '.svg': 'image/svg+xml', '.woff2': 'font/woff2' };
const CLIENT_ROUTES = new Set(['/', '/sources', '/skills', '/projects']);

async function createDashboard({ options, assetRoot = path.resolve(__dirname, '../web/dist/browser'), port = 0, devOrigin, reader = new Reader(options) } = {}) {
  if (devOrigin && !/^http:\/\/127\.0\.0\.1:\d+$/.test(devOrigin)) throw new Error('Development origin must be a loopback HTTP origin.');
  const server = http.createServer(async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; object-src 'none'");
    const json = (status, data) => { res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(req.method === 'HEAD' ? undefined : JSON.stringify(data)); };
    try {
      const host = `${HOST}:${server.address().port}`, origin = `http://${host}`;
      if (req.headers.host !== host || (req.headers.origin && req.headers.origin !== origin && req.headers.origin !== devOrigin) || req.headers['sec-fetch-site'] === 'cross-site') {
        throw new ReadError(ERROR.BOUNDARY, 'Only this local dashboard origin is allowed.', 403);
      }
      if (!['GET', 'HEAD'].includes(req.method)) { res.setHeader('Allow', 'GET, HEAD'); throw new ReadError(ERROR.METHOD, 'This dashboard supports reads only.', 405); }
      const rawPath = (req.url || '/').split('?')[0];
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
          if (doc) { operation = 'document'; args = [doc[1], url.searchParams.get('generation')]; }
          else if (project) { operation = 'project'; args = [project[1]]; }
          else throw new ReadError(ERROR.NOT_FOUND, 'Read endpoint not found.', 404);
        }
        if ([...url.searchParams.keys()].some(k => operation !== 'document' || k !== 'generation')) throw new ReadError(ERROR.INVALID, 'Unsupported query parameter.', 400);
        if (req.method === 'HEAD') { res.writeHead(204); res.end(); return; }
        json(200, await reader.run(operation, args)); return;
      }
      const filename = CLIENT_ROUTES.has(decoded) ? 'index.html' : decoded.slice(1);
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
    server.closeAllConnections(); await reader.close(); await closing;
  } };
}
module.exports = { createDashboard };
