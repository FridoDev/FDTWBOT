import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { prepareWAMessageMedia } from '@whiskeysockets/baileys';
import { preserveResendBehavior } from '../scripts/prepare.js';
import { build, releaseFiles } from '../scripts/build.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
test('fresh installation preserves the working resend customization, idempotently', () => {
  const original = "if (unavailableType === 'bot_unavailable_fanout' ||\n                            unavailableType === 'hosted_unavailable_fanout' ||\n                            unavailableType === 'view_once_unavailable_fanout') {";
  const patched = preserveResendBehavior(original);
  assert.doesNotMatch(patched, /view_once_unavailable_fanout/);
  assert.equal(preserveResendBehavior(patched), patched);
  assert.throws(() => preserveResendBehavior('changed upstream'), /refusing/);
  assert.throws(() => preserveResendBehavior(original + original), /refusing/);
});

test('manifest and lockfile agree on exact tested dependency versions', async () => {
  const manifest = JSON.parse(await fs.readFile(path.join(root, 'package.json'), 'utf8'));
  const lock = JSON.parse(await fs.readFile(path.join(root, 'package-lock.json'), 'utf8'));
  assert.deepEqual(manifest.dependencies, lock.packages[''].dependencies);
  assert.equal(manifest.name, lock.name);
  for (const [name, version] of Object.entries(manifest.dependencies)) assert.equal(lock.packages[`node_modules/${name}`].version, version);
  assert.equal(manifest.scripts.start, 'node src/index.js');
});

test('release archive includes only allowlisted source and verifies its checksum', async () => {
  await build();
  const archive = path.join(root, 'dist/downloads/still-bot.tar.gz');
  const result = spawnSync('tar', ['-tzf', 'dist/downloads/still-bot.tar.gz'], { cwd: root, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  const members = result.stdout.trim().split(/\r?\n/);
  assert.deepEqual(members.sort(), [...releaseFiles].sort());
  for (const member of members) assert.doesNotMatch(member, /(^|\/)(auth[^/]*|\.env[^/]*|\.local|node_modules|diagnostics|downloads|VENOM[^/]*)(\/|$)/);
  const digest = createHash('sha256').update(await fs.readFile(archive)).digest('hex');
  assert.equal(await fs.readFile(path.join(root, 'dist/downloads/still-bot.sha256'), 'utf8'), `${digest}  still-bot.tar.gz\n`);
});

test('real library prepares encrypted image media with optional thumbnail tools omitted', async () => {
  const image = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jL1sAAAAASUVORK5CYII=', 'base64');
  let encryptedSize = 0;
  const result = await prepareWAMessageMedia({ image }, {
    logger: { debug() {}, warn() {} },
    async upload(file) {
      encryptedSize = (await fs.readFile(file)).length;
      return { mediaUrl: 'https://example.invalid/fixture', directPath: '/fixture' };
    },
  });
  assert.ok(encryptedSize > image.length);
  assert.equal(Number(result.imageMessage.fileLength), image.length);
  assert.equal(result.imageMessage.mediaKey.length, 32);
  assert.equal(result.imageMessage.fileSha256.length, 32);
});

test('Termux scripts have valid Bash syntax and Unix line endings', async () => {
  for (const file of ['scripts/install.sh', 'scripts/termux-launch.sh']) {
    const source = await fs.readFile(path.join(root, file), 'utf8');
    assert.equal(source.includes('\r'), false);
    const result = spawnSync('bash', ['-n', file], { cwd: root, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
  }
});

test('installer rejects non-HTTPS or shell-bearing addresses without installing anything', () => {
  for (const origin of ['http://example.com', 'https://example.com/other', 'https://user:pass@example.com', 'https://example.com;touch bad', 'https://example.com:99999']) {
    const result = spawnSync('bash', ['scripts/install.sh', origin], { cwd: root, encoding: 'utf8' });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /HTTPS origin|origin port/);
    assert.doesNotMatch(result.stdout, /Downloading|Installing/);
  }
});
