import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { timingSafeEqual } from 'node:crypto';

const assets = new Map([
  ['/', ['index.html', 'text/html; charset=utf-8']],
  ['/index.html', ['index.html', 'text/html; charset=utf-8']],
  ['/styles.css', ['styles.css', 'text/css; charset=utf-8']],
  ['/app.js', ['app.js', 'text/javascript; charset=utf-8']],
  ['/icon.svg', ['icon.svg', 'image/svg+xml']],
]);

export function createDashboardServer({ controller, token, webDir, isReady = () => true }) {
  function json(res, status, data) {
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(data));
  }
  const server = http.createServer(async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; object-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
    const host = req.headers.host;
    const port = server.address()?.port;
    if (![`127.0.0.1:${port}`, `localhost:${port}`].includes(host)) return json(res, 403, { error: 'Local connections only.' });
    const origin = `http://${host}`;
    if (req.headers.origin && req.headers.origin !== origin) return json(res, 403, { error: 'Foreign websites cannot control this bot.' });
    if (req.headers['sec-fetch-site'] === 'cross-site' && req.url?.startsWith('/api/')) return json(res, 403, { error: 'Open the local dashboard using the shortcut.' });
    try {
      const url = new URL(req.url, origin);
      if (url.pathname.startsWith('/api/') && !isReady()) return json(res, 503, { error: 'Local service is still starting.' });
      if (url.pathname === '/api/health' && req.method === 'GET') return json(res, 200, { app: 'still-local', version: 1 });
      if (url.pathname.startsWith('/api/')) {
        const provided = req.headers['x-still-token'];
        if (typeof provided !== 'string' || !/^[a-f0-9]{64}$/.test(provided) || !timingSafeEqual(Buffer.from(provided), Buffer.from(token))) {
          return json(res, 401, { error: 'Open the Termux shortcut to unlock this dashboard.' });
        }
        if (req.method === 'GET' && url.pathname === '/api/status') return json(res, 200, controller.status());
        if (req.method !== 'POST') return json(res, 405, { error: 'Method not allowed.' });
        if (req.headers.origin !== origin) return json(res, 403, { error: 'A same-origin dashboard request is required.' });
        if (req.headers['content-type']?.split(';')[0] !== 'application/json') return json(res, 415, { error: 'JSON is required.' });
        let body = '';
        for await (const chunk of req) {
          body += chunk.toString('utf8');
          if (Buffer.byteLength(body) > 2048) {
            json(res, 413, { error: 'Request is too large.' });
            return;
          }
        }
        let input;
        try { input = JSON.parse(body); } catch { return json(res, 400, { error: 'Invalid JSON.' }); }
        if (!input || typeof input !== 'object' || Array.isArray(input)) return json(res, 400, { error: 'Expected a JSON object.' });
        const actions = {
          '/api/start': () => controller.start(input),
          '/api/reconnect': () => controller.reconnect(),
          '/api/stop': () => controller.stop(),
          '/api/new-session': () => controller.newSession(),
        };
        const action = actions[url.pathname];
        if (!action) return json(res, 404, { error: 'Unknown action.' });
        await action();
        return json(res, 202, { ok: true });
      }
      if (!['GET', 'HEAD'].includes(req.method)) return json(res, 405, { error: 'Method not allowed.' });
      const asset = assets.get(url.pathname);
      if (!asset) return json(res, 404, { error: 'Not found.' });
      const content = await fs.readFile(path.join(webDir, asset[0]));
      res.writeHead(200, { 'Content-Type': asset[1], 'Content-Length': content.length });
      res.end(req.method === 'HEAD' ? undefined : content);
    } catch (err) {
      if (!res.headersSent) json(res, err.status || 500, { error: err.status ? err.message : 'Local service error. Check the Termux runtime log.' });
      else res.end();
    }
  });
  server.requestTimeout = 15000;
  server.headersTimeout = 10000;
  return server;
}
