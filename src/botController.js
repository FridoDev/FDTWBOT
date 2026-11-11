import fs from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';
import makeWASocket, { Browsers, DisconnectReason, fetchLatestWaWebVersion, useMultiFileAuthState } from '@whiskeysockets/baileys';
import pino from 'pino';
import { registerMessageHandlers } from './messages.js';
import { botState } from './whatsapp.js';

const require = createRequire(import.meta.url);
const QRCode = require('qrcode-terminal/vendor/QRCode');
const QRLevel = require('qrcode-terminal/vendor/QRCode/QRErrorCorrectLevel');

export function qrDataUrl(value) {
  const qr = new QRCode(-1, QRLevel.M);
  qr.addData(value);
  qr.make();
  const size = qr.getModuleCount();
  let cells = '';
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      if (qr.isDark(y, x)) cells += `M${x + 4} ${y + 4}h1v1h-1z`;
    }
  }
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${size + 8} ${size + 8}" shape-rendering="crispEdges"><path fill="white" d="M0 0h${size + 8}v${size + 8}H0z"/><path fill="black" d="${cells}"/></svg>`;
  return `data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}`;
}

function actionError(message, status = 400) {
  return Object.assign(new Error(message), { status });
}

export function createBotController({ authDir, settingsFile, dependencies = {} }) {
  const deps = {
    makeSocket: makeWASocket,
    useAuth: useMultiFileAuthState,
    fetchVersion: fetchLatestWaWebVersion,
    onReady: registerMessageHandlers,
    setTimer: setTimeout,
    clearTimer: clearTimeout,
    ...dependencies,
  };
  const state = {
    status: 'stopped', account: '', hasSession: false, mode: 'code',
    qr: null, pairingCode: null, error: null, connectedAt: null,
  };
  let settings = { mode: 'code', phoneNumber: '', autoStart: false };
  let sock = null;
  let generation = 0;
  let retryTimer;
  let linkTimer;
  let retries = 0;
  let active = false;
  let busy = false;
  let saveQueue = Promise.resolve();
  let settingsQueue = Promise.resolve();
  let version;

  const clearLink = () => {
    deps.clearTimer(linkTimer);
    state.qr = null;
    state.pairingCode = null;
    state.connectedAt = null;
  };
  const publish = () => {
    botState.status = state.status === 'connected' ? 'CONNECTED' : state.status;
    botState.account = state.account;
    botState.sock = sock;
  };
  const saveSettings = () => {
    const contents = JSON.stringify(settings);
    settingsQueue = settingsQueue.catch(() => {}).then(async () => {
      await fs.mkdir(path.dirname(settingsFile), { recursive: true, mode: 0o700 });
      const temp = `${settingsFile}.tmp`;
      await fs.writeFile(temp, contents, { mode: 0o600 });
      await fs.rename(temp, settingsFile);
    });
    return settingsQueue;
  };
  const refreshSession = async () => {
    if (settings.revoked) {
      state.hasSession = false;
      state.status = 'logged_out';
      state.error = 'WhatsApp logged this device out. Choose New link, then link again.';
      return;
    }
    try {
      const creds = JSON.parse(await fs.readFile(path.join(authDir, 'creds.json'), 'utf8'));
      state.hasSession = creds.registered === true;
      if (state.hasSession) state.account = creds.me?.id?.split(':')[0]?.split('@')[0] || '';
    } catch (err) {
      if (err.code !== 'ENOENT') throw actionError('Saved session could not be read. Keep the files and use New link to archive them.');
      state.hasSession = false;
    }
  };
  const closeSocket = async () => {
    ++generation;
    deps.clearTimer(retryTimer);
    clearLink();
    const previous = sock;
    sock = null;
    state.status = 'stopped';
    publish();
    if (previous) await previous.end(new Error('Local dashboard stopped the connection'));
    await saveQueue;
  };
  const fail = async (message) => {
    active = false;
    await closeSocket();
    state.status = 'error';
    state.error = message;
    publish();
  };
  const timed = (promise, ms, message) => {
    let timer;
    return Promise.race([
      promise,
      new Promise((_, reject) => { timer = deps.setTimer(() => reject(new Error(message)), ms); }),
    ]).finally(() => deps.clearTimer(timer));
  };

  async function connect() {
    const epoch = ++generation;
    try {
      const auth = await deps.useAuth(authDir);
      if (!active || epoch !== generation) return;
      state.hasSession = auth.state.creds.registered === true;
      if (!version) {
        try {
          ({ version } = await timed(deps.fetchVersion(), 10000, 'Version lookup timed out'));
        } catch { /* The library ships a default version for offline version lookups. */ }
      }
      if (!active || epoch !== generation) return;
      const current = deps.makeSocket({
        ...(version ? { version } : {}), auth: auth.state,
        logger: pino({ level: 'silent' }), printQRInTerminal: false,
        browser: settings.mode === 'code' ? Browsers.ubuntu('Chrome') : ['Research Bot', 'Chrome', '1.0'],
      });
      sock = current;
      publish();
      let pairingRequested = false;
      let handlersRegistered = false;
      current.ev.on('creds.update', () => {
        if (!active || epoch !== generation) return;
        saveQueue = saveQueue.then(async () => {
          await auth.saveCreds();
          if (epoch === generation) state.hasSession = auth.state.creds.registered === true;
        }).catch(async () => {
          if (epoch === generation) {
            active = false;
            state.status = 'error';
            state.error = 'Could not save the WhatsApp session. Check free storage on this device.';
            ++generation;
            clearLink();
            sock = null;
            publish();
            await current.end(new Error('Session storage failed'));
          }
        });
      });
      current.ev.on('connection.update', (update) => {
        void handleUpdate(update).catch(async () => {
          if (epoch === generation) await fail('Connection setup failed. Try reconnecting, or switch to QR linking.');
        });
      });
      async function handleUpdate({ connection, lastDisconnect, qr }) {
        if (!active || epoch !== generation) return;
        if (connection === 'close') {
          sock = null;
          clearLink();
          const code = lastDisconnect?.error?.output?.statusCode;
          if (code === DisconnectReason.loggedOut || code === DisconnectReason.connectionReplaced) {
            active = false;
            ++generation;
            state.status = code === DisconnectReason.loggedOut ? 'logged_out' : 'error';
            if (code === DisconnectReason.loggedOut) {
              state.hasSession = false;
              settings.revoked = true;
              settings.autoStart = false;
              await saveSettings();
            }
            state.error = code === DisconnectReason.loggedOut
              ? 'WhatsApp logged this device out. Choose New link, then link again.'
              : 'Another bot is using this session. Stop the other copy before reconnecting.';
          } else if (++retries <= 5) {
            ++generation;
            state.status = 'reconnecting';
            retryTimer = deps.setTimer(() => {
              void saveQueue.then(() => { if (active) return connect(); });
            }, code === DisconnectReason.restartRequired ? 1000 : Math.min(3000 * retries, 15000));
          } else {
            active = false;
            ++generation;
            state.status = 'error';
            state.error = 'Connection could not be restored after five attempts. Check internet access, then try again.';
          }
          publish();
          return;
        }
        if (connection === 'connecting') {
          state.status = 'connecting';
          publish();
        }
        if (connection === 'open') {
          if (!handlersRegistered) {
            deps.onReady(current);
            handlersRegistered = true;
          }
          retries = 0;
          clearLink();
          state.status = 'connected';
          state.account = current.user?.id?.split(':')[0]?.split('@')[0] || '';
          state.hasSession = auth.state.creds.registered === true;
          state.error = null;
          state.connectedAt = new Date().toISOString();
          publish();
        }
        if (qr && !auth.state.creds.registered) {
          state.status = 'awaiting_link';
          if (settings.mode === 'qr') {
            state.qr = qrDataUrl(qr);
          } else if (!pairingRequested) {
            pairingRequested = true;
            try {
              const code = await timed(current.requestPairingCode(settings.phoneNumber), 20000, 'Pairing code request timed out');
              if (epoch !== generation || !active || state.status === 'connected') return;
              state.pairingCode = code;
              linkTimer = deps.setTimer(() => {
                if (epoch === generation && active) void fail('Linking expired. Start again for a fresh code, or try QR on a second screen.');
              }, 120000);
            } catch {
              if (epoch === generation) await fail('WhatsApp did not provide a usable pairing code. Try again, or use QR on a second screen.');
            }
          }
          publish();
        }
      }
    } catch {
      if (epoch === generation) await fail('Could not start WhatsApp. Check your internet connection and available device storage.');
    }
  }

  async function exclusive(action) {
    if (busy) throw actionError('Another action is still finishing. Please wait.', 409);
    busy = true;
    try { return await action(); } finally { busy = false; }
  }
  async function begin(input = {}) {
    if (active) throw actionError('The bot is already running or connecting.', 409);
    if (settings.revoked || state.status === 'logged_out') throw actionError('Choose New link before linking a logged-out session.', 409);
    await refreshSession();
    if (!state.hasSession) {
      const mode = input.mode || settings.mode;
      if (!['code', 'qr'].includes(mode)) throw actionError('Choose code or QR linking.');
      const raw = input.phoneNumber ?? settings.phoneNumber;
      if (typeof raw !== 'string' || raw.length > 32 || !/^[+\d\s()-]*$/.test(raw)) throw actionError('Enter a valid international phone number.');
      const phoneNumber = raw.replace(/\D/g, '');
      if (mode === 'code' && !/^[1-9]\d{7,14}$/.test(phoneNumber)) throw actionError('Enter your number with country code, using 8–15 digits.');
      settings = { mode, phoneNumber, autoStart: true };
    } else settings.autoStart = true;
    await saveSettings();
    state.mode = settings.mode;
    state.error = null;
    state.status = 'starting';
    clearLink();
    active = true;
    retries = 0;
    publish();
    void connect();
  }
  return {
    async initialize() {
      try { settings = { ...settings, ...JSON.parse(await fs.readFile(settingsFile, 'utf8')) }; }
      catch (err) { if (err.code !== 'ENOENT') throw new Error('Local dashboard settings are unreadable.'); }
      await refreshSession();
      state.mode = settings.mode;
      publish();
    },
    status() { return { ...state, messages: botState.msgCount }; },
    start(input) { return exclusive(() => begin(input)); },
    reconnect() {
      return exclusive(async () => {
        if (!state.hasSession || state.status === 'logged_out') throw actionError('No usable saved session. Start a new link first.', 409);
        active = false;
        await closeSocket();
        await begin();
      });
    },
    stop() {
      return exclusive(async () => {
        active = false;
        await closeSocket();
        settings.autoStart = false;
        await saveSettings();
        state.status = 'stopped';
        state.error = null;
        publish();
      });
    },
    newSession() {
      return exclusive(async () => {
        active = false;
        await closeSocket();
        try { await fs.rename(authDir, `${authDir}-archive-${Date.now()}`); }
        catch (err) { if (err.code !== 'ENOENT') throw actionError('Could not archive the old session. No files were deleted.', 500); }
        settings = { mode: 'code', phoneNumber: '', autoStart: false };
        await saveSettings();
        Object.assign(state, { status: 'stopped', hasSession: false, account: '', error: null, mode: 'code' });
        publish();
      });
    },
    async resume() { if (settings.autoStart && state.hasSession) await this.start(); },
    async shutdown() { active = false; await closeSocket(); await settingsQueue; },
  };
}
