import makeWASocket, {
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestWaWebVersion,
} from '@whiskeysockets/baileys';
import qrcode from 'qrcode-terminal';
import pino from 'pino';
import { config } from './config.js';
import { log } from './utils.js';

export const botState = {
  status: 'Disconnected',
  account: '',
  msgCount: 0,
  sock: null,
};

let reconnectCount = 0;
const MAX_RECONNECT = 5;

export async function startWhatsApp(onReady) {
  const { state, saveCreds } = await useMultiFileAuthState(config.authDir);
  const pairingNumber = config.myNumber.replace(/\D/g, '');
  if (config.pairingCode && !state.creds.registered && !/^[1-9]\d{7,14}$/.test(pairingNumber)) {
    throw new Error('Set MY_WHATSAPP_NUMBER to your number including country code before requesting a pairing code.');
  }
  let pairingRequested = false;

  // Fetch the latest WhatsApp Web version.
  // WhatsApp rejects connections from outdated clients, so we always fetch
  // the real current version before connecting.
  let version;
  try {
    ({ version } = await fetchLatestWaWebVersion());
    log('WA version', version.join('.'));
  } catch {
    log('WA version', 'fetch failed, using Baileys default');
  }

  const logger = pino({ level: 'silent' });

  const sock = makeWASocket({
    ...(version ? { version } : {}),
    auth: state,
    logger,
    // Must be false — we handle QR ourselves via qrcode-terminal
    printQRInTerminal: false,
    browser: ['Research Bot', 'Chrome', '1.0'],
  });

  botState.sock = sock;

  // Raw WS listener to catch ALL incoming messages before Baileys processes them
  sock.ws.on('CB:message', (node) => {
    log('RAW CB:message', `from=${node.attrs?.from || 'none'} id=${node.attrs?.id || 'none'}`);
  });

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr && config.pairingCode && !state.creds.registered) {
      if (pairingRequested) return;
      pairingRequested = true;
      try {
        const code = await sock.requestPairingCode(pairingNumber);
        log('PAIRING CODE', `${code} (configured number ending ${pairingNumber.slice(-4)})`);
        log('LINK DEVICE', 'WhatsApp > Linked devices > Link a device > Link with phone number instead');
      } catch (err) {
        pairingRequested = false;
        log('PAIRING FAILED', err.message);
      }
    } else if (qr) {
      console.log('\n========================================');
      console.log('  Scan this QR code with WhatsApp');
      console.log('  Phone → Linked Devices → Link a Device');
      console.log('========================================\n');
      qrcode.generate(qr, { small: true });
      console.log('\n  QR refreshes automatically every 20s.');
      console.log('  Scan before it expires.\n');
    }

    if (connection === 'connecting') {
      botState.status = 'Connecting...';
      log('Connecting to WhatsApp...');
    }

    if (connection === 'open') {
      reconnectCount = 0;
      botState.status = 'CONNECTED';
      const me = sock.user;
      botState.account = me?.id?.split(':')[0] || me?.id || '';

      console.log('\n========================================');
      console.log('  FRIDO DEV BOT | FRIDO DEV TECH');
      console.log('  Created by FRIDO');
      console.log('  Status: CONNECTED ✓');
      console.log(`  Account: +${botState.account}`);
      console.log('========================================\n');

      onReady(sock);
    }

    if (connection === 'close') {
      const code = lastDisconnect?.error?.output?.statusCode;
      const shouldReconnect = code !== DisconnectReason.loggedOut;

      if (shouldReconnect && reconnectCount < MAX_RECONNECT) {
        reconnectCount++;
        botState.status = 'Reconnecting...';
        log('CONNECTION closed', `reason=${code} attempt=${reconnectCount}/${MAX_RECONNECT}`);
        setTimeout(() => startWhatsApp(onReady), 3000 * reconnectCount);
      } else if (code === DisconnectReason.loggedOut) {
        botState.status = 'Logged out';
        log('LOGGED OUT', 'Set WHATSAPP_AUTH_DIR to a new directory and restart to re-link without deleting the old session.');
        process.exit(0);
      } else {
        log('CONNECTION failed', 'Max reconnect attempts reached.');
        process.exit(1);
      }
    }
  });

  return sock;
}
