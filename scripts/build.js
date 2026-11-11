import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const output = path.join(root, 'dist');
export const releaseFiles = [
  'package.json', 'package-lock.json',
  'src/index.js', 'src/config.js', 'src/whatsapp.js', 'src/messages.js',
  'src/commands.js', 'src/utils.js', 'src/viewOnce.js', 'src/reactions.js',
  'src/deletedMessages.js', 'src/media.js', 'src/diagnostics.js',
  'src/botController.js', 'src/dashboard.js', 'src/dashboardServer.js',
  'src/viewOnce.test.js', 'src/dashboard.test.js', 'src/release.test.js', 'src/commands.test.js',
  'scripts/prepare.js', 'scripts/verify-runtime.js', 'scripts/build.js',
  'scripts/install.sh', 'scripts/termux-launch.sh',
  'web/index.html', 'web/styles.css', 'web/app.js', 'web/icon.svg',
];

export async function build() {
  for (const file of releaseFiles) {
    const info = await fs.lstat(path.join(root, file));
    if (!info.isFile() || info.isSymbolicLink()) throw new Error(`Release input is not a regular file: ${file}`);
  }
  await fs.mkdir(path.join(output, 'downloads'), { recursive: true });
  const existing = await fs.readdir(output);
  const allowed = new Set(['downloads', 'index.html', 'styles.css', 'app.js', 'icon.svg', 'install.sh']);
  if (existing.some(name => !allowed.has(name))) throw new Error('Unexpected files in dist. Inspect them before rebuilding.');
  const downloads = await fs.readdir(path.join(output, 'downloads'));
  if (downloads.some(name => !['still-bot.tar.gz', 'still-bot.sha256'].includes(name))) throw new Error('Unexpected files in dist/downloads. Inspect them before rebuilding.');
  for (const file of ['index.html', 'styles.css', 'app.js', 'icon.svg']) await fs.copyFile(path.join(root, 'web', file), path.join(output, file));
  await fs.copyFile(path.join(root, 'scripts/install.sh'), path.join(output, 'install.sh'));
  const archive = path.join(output, 'downloads/still-bot.tar.gz');
  const result = spawnSync('tar', ['-czf', 'dist/downloads/still-bot.tar.gz', ...releaseFiles], { cwd: root, encoding: 'utf8' });
  if (result.status !== 0) throw new Error(result.stderr || result.error?.message || 'Could not build phone archive.');
  const bytes = await fs.readFile(archive);
  const digest = createHash('sha256').update(bytes).digest('hex');
  await fs.writeFile(path.join(output, 'downloads/still-bot.sha256'), `${digest}  still-bot.tar.gz\n`);
  console.log(`Static website ready in dist; phone bundle ${bytes.length} bytes, ${releaseFiles.length} allowlisted files. No credentials or installed dependencies included.`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await build();
