import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';
import { config } from './config.js';
import { createDashboardServer } from './dashboardServer.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dataDir = path.resolve(process.env.STILL_DATA_DIR || path.join(root, '.local'));
const port = Number(process.env.PORT || 8787);
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('PORT must be between 1 and 65535.');
process.umask(0o077);
config.authDir = path.join(dataDir, 'auth');
config.diagnosticsDir = path.join(dataDir, 'diagnostics');
config.downloadsDir = path.join(dataDir, 'downloads');
config.viewOnceDir = path.join(dataDir, 'downloads', 'view-once-tests');
config.diagnosticMode = false;
config.normalMediaMode = false;
config.viewOnceTest = false;
config.selfJid = '';

const { createBotController } = await import('./botController.js');
const controller = createBotController({ authDir: config.authDir, settingsFile: path.join(dataDir, 'settings.json') });
const token = randomBytes(32).toString('hex');
let ready = false;
const server = createDashboardServer({ controller, token, webDir: path.join(root, 'web'), isReady: () => ready });
server.on('error', err => {
  console.error(err.code === 'EADDRINUSE'
    ? `Port ${port} is already in use. Open the existing dashboard instead of starting another copy.`
    : `Local dashboard could not listen: ${err.code || 'unknown error'}`);
  process.exitCode = 1;
});
server.listen(port, '127.0.0.1', async () => {
  try {
    await fs.mkdir(dataDir, { recursive: true, mode: 0o700 });
    await controller.initialize();
    await fs.writeFile(path.join(dataDir, 'dashboard-token'), token, { mode: 0o600 });
    ready = true;
    console.log('FRIDO DEV BOT | FRIDO DEV TECH | Created by FRIDO');
    console.log(`Local dashboard: http://127.0.0.1:${port}/#token=${token}`);
    console.log('Keep Termux running in the background. Stop in the dashboard to pause without logging out.');
    await controller.resume();
  } catch (err) {
    console.error(`Dashboard startup failed: ${err.message}`);
    server.close();
    process.exitCode = 1;
  }
});
let shuttingDown = false;
async function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  await controller.shutdown();
  server.close();
  server.closeIdleConnections();
}
process.on('SIGINT', () => { void shutdown(); });
process.on('SIGTERM', () => { void shutdown(); });
