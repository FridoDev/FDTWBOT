import 'dotenv/config';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

export const config = {
  myNumber: process.env.MY_WHATSAPP_NUMBER || '',
  pairingCode: process.env.PAIRING_CODE === 'true',
  selfJid: process.env.MY_SELF_JID || '',
  diagnosticMode: process.env.DIAGNOSTIC_MODE !== 'false',
  normalMediaMode: process.env.NORMAL_MEDIA_TEST_MODE !== 'false',
  viewOnceTest: process.env.VIEW_ONCE_TEST === 'true',

  authDir: path.resolve(ROOT, process.env.WHATSAPP_AUTH_DIR || 'auth'),
  diagnosticsDir: path.join(ROOT, 'diagnostics'),
  downloadsDir: path.join(ROOT, 'downloads'),
  viewOnceDir: path.join(ROOT, 'downloads', 'view-once-tests'),
};
