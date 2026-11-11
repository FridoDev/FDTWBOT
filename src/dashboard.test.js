import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import http from 'node:http';
import { createBotController, qrDataUrl } from './botController.js';
import { createDashboardServer } from './dashboardServer.js';

const flush = () => new Promise(resolve => setImmediate(resolve));
async function harness(t, saved = false, overrides = {}) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'still-controller-'));
  const authDir = path.join(dir, 'auth');
  await fs.mkdir(authDir);
  const creds = { registered: saved, me: { id: '123456789:3@s.whatsapp.net' } };
  if (saved) await fs.writeFile(path.join(authDir, 'creds.json'), JSON.stringify(creds));
  const sockets = [];
  const timers = new Set();
  let registrations = 0;
  const controller = createBotController({
    authDir, settingsFile: path.join(dir, 'settings.json'),
    dependencies: {
      async useAuth() {
        const state = { creds };
        return { state, async saveCreds() { await fs.writeFile(path.join(authDir, 'creds.json'), JSON.stringify(state.creds)); } };
      },
      async fetchVersion() { return { version: [2, 3000, 1] }; },
      makeSocket(options) {
        const sock = {
          options, ev: new EventEmitter(), user: { id: '123456789:3@s.whatsapp.net' }, ended: 0, codes: [],
          async requestPairingCode(number) { this.codes.push(number); return 'ABCD1234'; },
          async end() { this.ended++; this.ev.emit('connection.update', { connection: 'close' }); },
        };
        sockets.push(sock);
        return sock;
      },
      onReady() { registrations++; },
      setTimer(callback, ms) { const timer = { callback, ms }; timers.add(timer); return timer; },
      clearTimer(timer) { timers.delete(timer); },
      ...overrides,
    },
  });
  await controller.initialize();
  t.after(async () => { await controller.shutdown(); await fs.rm(dir, { recursive: true, force: true }); });
  async function settle() {
    for (let i = 0; i < 15; i++) await flush();
  }
  return { controller, sockets, timers, dir, authDir, settle, registrations: () => registrations };
}

test('new code link is not called connected until WhatsApp confirms; handlers only register once', async t => {
  const h = await harness(t);
  await h.controller.start({ mode: 'code', phoneNumber: '+123 456 7890' });
  await h.settle();
  const sock = h.sockets[0];
  assert.equal(h.controller.status().status, 'starting');
  sock.ev.emit('connection.update', { qr: 'local-test-fixture' });
  await h.settle();
  assert.deepEqual(sock.codes, ['1234567890']);
  assert.equal(h.controller.status().status, 'awaiting_link');
  assert.equal(h.controller.status().pairingCode, 'ABCD1234');
  assert.deepEqual(sock.options.browser, ['Ubuntu', 'Chrome', '22.04.4']);
  sock.options.auth.creds.registered = true;
  sock.ev.emit('creds.update', {});
  sock.ev.emit('connection.update', { connection: 'open' });
  sock.ev.emit('connection.update', { connection: 'open' });
  await h.settle();
  assert.equal(h.registrations(), 1);
  assert.equal(h.controller.status().status, 'connected');
  assert.equal(h.controller.status().pairingCode, null);
  assert.equal(h.controller.status().hasSession, true);
  assert.equal(h.controller.status().account, '123456789');
});

test('QR refresh uses local encoder and preserves QR browser identity', async t => {
  const h = await harness(t);
  await h.controller.start({ mode: 'qr' });
  await h.settle();
  h.sockets[0].ev.emit('connection.update', { qr: 'fixture-one' });
  const first = h.controller.status().qr;
  h.sockets[0].ev.emit('connection.update', { qr: 'fixture-two' });
  assert.notEqual(first, h.controller.status().qr);
  assert.match(first, /^data:image\/svg\+xml;base64,/);
  assert.deepEqual(h.sockets[0].options.browser, ['Research Bot', 'Chrome', '1.0']);
  assert.equal(h.sockets[0].codes.length, 0);
});

test('stop keeps credentials; reconnect uses saved session and prevents duplicate starts', async t => {
  const h = await harness(t, true);
  await h.controller.start();
  await h.settle();
  await assert.rejects(h.controller.start(), /already running/);
  await h.controller.stop();
  assert.equal(h.sockets[0].ended, 1);
  assert.equal(h.controller.status().status, 'stopped');
  assert.equal(h.timers.size, 0);
  assert.equal(JSON.parse(await fs.readFile(path.join(h.authDir, 'creds.json'))).registered, true);
  await h.controller.reconnect();
  await h.settle();
  assert.equal(h.sockets.length, 2);
  assert.equal(h.sockets[1].codes.length, 0);
});

test('late connection events after stop cannot revive a socket or reveal a code', async t => {
  const h = await harness(t);
  await h.controller.start({ mode: 'code', phoneNumber: '1234567890' });
  await h.settle();
  const sock = h.sockets[0];
  await h.controller.stop();
  sock.ev.emit('connection.update', { connection: 'open', qr: 'stale' });
  await h.settle();
  assert.equal(h.controller.status().status, 'stopped');
  assert.equal(h.controller.status().pairingCode, null);
  assert.equal(h.registrations(), 0);
});

test('late credential updates from a stopped socket cannot overwrite the saved session', async t => {
  const h = await harness(t, true);
  await h.controller.start();
  await h.settle();
  const sock = h.sockets[0];
  await h.controller.stop();
  sock.options.auth.creds.registered = false;
  sock.ev.emit('creds.update', {});
  await h.settle();
  await h.controller.shutdown();
  assert.equal(JSON.parse(await fs.readFile(path.join(h.authDir, 'creds.json'))).registered, true);
});

test('restart-required reconnects without unlinking or new code', async t => {
  const h = await harness(t, true);
  await h.controller.start();
  await h.settle();
  h.sockets[0].ev.emit('connection.update', { connection: 'close', lastDisconnect: { error: { output: { statusCode: 515 } } } });
  assert.equal(h.controller.status().status, 'reconnecting');
  const timer = [...h.timers][0];
  assert.equal(timer.ms, 1000);
  h.timers.delete(timer);
  timer.callback();
  await h.settle();
  assert.equal(h.sockets.length, 2);
  assert.equal(h.sockets[1].codes.length, 0);
});

test('logout requires new link and never automatically retries', async t => {
  const h = await harness(t, true);
  await h.controller.start();
  await h.settle();
  h.sockets[0].ev.emit('connection.update', { connection: 'close', lastDisconnect: { error: { output: { statusCode: 401 } } } });
  assert.equal(h.controller.status().status, 'logged_out');
  assert.equal(h.controller.status().hasSession, false);
  assert.equal(h.timers.size, 0);
  await assert.rejects(h.controller.reconnect(), /No usable saved session/);
  await h.controller.stop();
  await assert.rejects(h.controller.start(), /logged-out session/);
  await h.controller.initialize();
  await h.controller.resume();
  assert.equal(h.controller.status().status, 'logged_out');
  assert.equal(h.sockets.length, 1);
});

test('new link archives existing files rather than deleting credentials', async t => {
  const h = await harness(t, true);
  await h.controller.newSession();
  const archive = (await fs.readdir(h.dir)).find(name => name.startsWith('auth-archive-'));
  assert.ok(archive);
  assert.equal(JSON.parse(await fs.readFile(path.join(h.dir, archive, 'creds.json'))).registered, true);
  assert.equal(h.controller.status().hasSession, false);
  assert.equal(h.controller.status().account, '');
});

test('bad phone input never opens a WhatsApp connection', async t => {
  const h = await harness(t);
  for (const phoneNumber of ['abc12345678', '00000000', '123', '1234567890123456', {}, '1;rm']) {
    await assert.rejects(h.controller.start({ mode: 'code', phoneNumber }));
  }
  assert.equal(h.sockets.length, 0);
});

test('stopping during asynchronous startup prevents socket creation', async t => {
  let resolve;
  const h = await harness(t, false, { fetchVersion: () => new Promise(r => { resolve = r; }) });
  await h.controller.start({ mode: 'qr' });
  await h.settle();
  await h.controller.stop();
  resolve({ version: [2, 3, 4] });
  await h.settle();
  assert.equal(h.sockets.length, 0);
});

test('pairing expiry clears the code and reports failure honestly', async t => {
  const h = await harness(t);
  await h.controller.start({ mode: 'code', phoneNumber: '1234567890' });
  await h.settle();
  h.sockets[0].ev.emit('connection.update', { qr: 'fixture' });
  await h.settle();
  const timer = [...h.timers].find(item => item.ms === 120000);
  timer.callback();
  await h.settle();
  assert.equal(h.controller.status().status, 'error');
  assert.equal(h.controller.status().pairingCode, null);
  assert.match(h.controller.status().error, /expired/);
});

test('QR encoder does not embed raw input as executable SVG', () => {
  const svg = Buffer.from(qrDataUrl('<script>alert(1)</script>').split(',')[1], 'base64').toString();
  assert.match(svg, /<svg/);
  assert.doesNotMatch(svg, /<script/);
});

test('dashboard API requires local host, same-origin control and private token', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'still-http-'));
  await fs.writeFile(path.join(dir, 'index.html'), '<!doctype html><title>fixture</title>');
  const calls = [];
  const controller = {
    status: () => ({ status: 'stopped', pairingCode: 'PRIVATE-CODE' }),
    async start(body) { calls.push(['start', body]); },
    async reconnect() { calls.push(['reconnect']); },
    async stop() { calls.push(['stop']); },
    async newSession() { calls.push(['new-session']); },
  };
  const token = 'a'.repeat(64);
  const server = createDashboardServer({ controller, token, webDir: dir });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); await fs.rm(dir, { recursive: true, force: true }); });
  const auth = { 'X-Still-Token': token };
  assert.deepEqual(await (await fetch(`${origin}/api/health`)).json(), { app: 'still-local', version: 1 });
  let response = await fetch(`${origin}/api/status`);
  assert.equal(response.status, 401);
  assert.doesNotMatch(await response.text(), /PRIVATE-CODE/);
  response = await fetch(`${origin}/api/status`, { headers: auth });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.equal(response.headers.get('access-control-allow-origin'), null);
  assert.equal((await response.json()).pairingCode, 'PRIVATE-CODE');
  const hostileHostStatus = await new Promise((resolve, reject) => {
    const request = http.get(`${origin}/api/status`, { headers: { ...auth, Host: 'attacker.invalid' } }, result => { result.resume(); resolve(result.statusCode); });
    request.on('error', reject);
  });
  assert.equal(hostileHostStatus, 403);
  assert.equal((await fetch(`${origin}/api/status`, { headers: { ...auth, Origin: 'https://attacker.invalid' } })).status, 403);
  const options = { method: 'POST', headers: { ...auth, Origin: origin, 'Content-Type': 'application/json' }, body: '{}' };
  assert.equal((await fetch(`${origin}/api/start`, { ...options, headers: { ...options.headers, Origin: 'https://attacker.invalid' } })).status, 403);
  assert.equal((await fetch(`${origin}/api/start`, { ...options, headers: { ...auth, 'Content-Type': 'application/json' } })).status, 403);
  assert.equal((await fetch(`${origin}/api/start`, { ...options, body: 'not JSON' })).status, 400);
  assert.equal((await fetch(`${origin}/api/start`, { ...options, body: '[]' })).status, 400);
  assert.equal((await fetch(`${origin}/api/start`, { ...options, body: JSON.stringify({ data: 'x'.repeat(3000) }) })).status, 413);
  for (const route of ['start', 'stop', 'reconnect', 'new-session']) assert.equal((await fetch(`${origin}/api/${route}`, options)).status, 202);
  assert.equal(calls.length, 4);
  for (const route of ['/auth/creds.json', '/.env', '/.local/dashboard-token', '/src/config.js']) assert.equal((await fetch(origin + route)).status, 404);
  response = await fetch(origin);
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-security-policy'), /frame-ancestors 'none'/);
});
