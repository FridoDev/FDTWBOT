import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export function preserveResendBehavior(source) {
  const original = /if \(unavailableType === 'bot_unavailable_fanout' \|\|\s*unavailableType === 'hosted_unavailable_fanout' \|\|\s*unavailableType === 'view_once_unavailable_fanout'\) \{/g;
  const patched = /if \(unavailableType === 'bot_unavailable_fanout' \|\|\s*unavailableType === 'hosted_unavailable_fanout'\) \{/g;
  if ([...source.matchAll(patched)].length === 1 && [...source.matchAll(original)].length === 0) return source;
  if ([...source.matchAll(original)].length !== 1) throw new Error('Unexpected Baileys resend implementation; refusing to change it.');
  return source.replace(original, "if (unavailableType === 'bot_unavailable_fanout' ||\n                            unavailableType === 'hosted_unavailable_fanout') {");
}

export async function prepare(root) {
  const library = path.join(root, 'node_modules', '@whiskeysockets', 'baileys');
  const pkg = JSON.parse(await fs.readFile(path.join(library, 'package.json'), 'utf8'));
  if (pkg.version !== '7.0.0-rc14') throw new Error('This project requires the tested Baileys 7.0.0-rc14.');
  const file = path.join(library, 'lib', 'Socket', 'messages-recv.js');
  const source = await fs.readFile(file, 'utf8');
  const result = preserveResendBehavior(source);
  if (result !== source) await fs.writeFile(file, result);
  console.log('Verified the installed view-once resend behavior.');
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await prepare(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'));
}
