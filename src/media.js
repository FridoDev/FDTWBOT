import fs from 'fs';
import path from 'path';
import { downloadMediaMessage } from '@whiskeysockets/baileys';
import { config } from './config.js';
import { log, safeName, getMediaExt, ensureDir } from './utils.js';

export const normalMediaStats = { count: 0 };

export async function handleNormalMedia(sock, msg, mediaType) {
  normalMediaStats.count++;
  log(`NORMAL ${mediaType.toUpperCase()} detected`);

  if (!config.normalMediaMode) return;

  try {
    const buffer = await downloadMediaMessage(msg, 'buffer', {}, {
      logger: { info: () => {}, error: () => {} },
      reuploadRequest: sock.updateMediaMessage,
    });

    ensureDir(config.downloadsDir);
    const ext = getMediaExt(mediaType);
    const filename = safeName(`${mediaType}`, ext);
    const filePath = path.join(config.downloadsDir, filename);
    fs.writeFileSync(filePath, buffer);
    log(`NORMAL ${mediaType.toUpperCase()} saved`, filePath);
  } catch (err) {
    log(`NORMAL ${mediaType.toUpperCase()} download failed`, err.message);
  }
}
