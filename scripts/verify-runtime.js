import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { preserveResendBehavior } from './prepare.js';

if (Number(process.versions.node.split('.')[0]) < 22) throw new Error('Use Node.js 22 or newer.');
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const source = await fs.readFile(path.join(root, 'node_modules/@whiskeysockets/baileys/lib/Socket/messages-recv.js'), 'utf8');
if (preserveResendBehavior(source) !== source) throw new Error('Required resend behavior is missing. Run npm run postinstall.');
const library = await import('@whiskeysockets/baileys');
if (typeof library.default !== 'function' || !library.proto) throw new Error('WhatsApp library did not load.');
await import('../src/botController.js');
try { await import('sharp'); }
catch { console.log('Native image previews are unavailable on this device; media sending can continue without generated thumbnails.'); }
console.log(`Runtime imports verified on ${process.platform}/${process.arch}, Node ${process.versions.node}. No WhatsApp connection was opened.`);
