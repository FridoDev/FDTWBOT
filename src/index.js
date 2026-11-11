import { startWhatsApp } from './whatsapp.js';
import { registerMessageHandlers } from './messages.js';
import { log } from './utils.js';

console.log('\n========================================');
console.log('  FRIDO DEV BOT | FRIDO DEV TECH');
console.log('  Created by FRIDO');
console.log('  Status: Starting...');
console.log('========================================\n');

process.on('uncaughtException', (err) => log('UNCAUGHT ERROR', err.message));
process.on('unhandledRejection', (err) => log('UNHANDLED REJECTION', err?.message || String(err)));

process.on('SIGINT', () => {
  log('Shutting down gracefully...');
  process.exit(0);
});

await startWhatsApp((sock) => {
  registerMessageHandlers(sock);
});
