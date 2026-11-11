import fs from 'fs';
import path from 'path';

export function ts() {
  const d = new Date();
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  const ss = String(d.getSeconds()).padStart(2, '0');
  return `[${hh}:${mm}:${ss}]`;
}

export function log(label, msg = '') {
  console.log(`${ts()} ${label}${msg ? ' ' + msg : ''}`);
}

export function safeName(prefix, ext) {
  const t = Date.now();
  const safe = prefix.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 40);
  return `${safe}_${t}${ext}`;
}

export function getMediaExt(mediaType) {
  const map = {
    image: '.jpg',
    video: '.mp4',
    audio: '.ogg',
    document: '.bin',
    sticker: '.webp',
  };
  return map[mediaType] || '.bin';
}

export function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

export function getContentTypeFromMessage(msgContent) {
  if (!msgContent) return null;
  const types = [
    'imageMessage', 'videoMessage', 'audioMessage', 'documentMessage',
    'stickerMessage', 'viewOnceMessage', 'viewOnceMessageV2',
    'viewOnceMessageV2Extension',
  ];
  for (const t of types) {
    if (msgContent[t]) return t;
  }
  return null;
}

export function unwrapMessageContent(content) {
  for (let depth = 0; content && depth < 10; depth++) {
    const wrapper = content.ephemeralMessage || content.deviceSentMessage ||
      content.viewOnceMessage || content.viewOnceMessageV2 || content.viewOnceMessageV2Extension;
    if (!wrapper?.message) break;
    content = wrapper.message;
  }
  return content;
}

export function extractViewOnceInner(msgContent) {
  return isViewOnce(msgContent) ? unwrapMessageContent(msgContent) : null;
}

export function isViewOnce(content) {
  for (let depth = 0; content && depth < 10; depth++) {
    if (content.viewOnceMessage || content.viewOnceMessageV2 || content.viewOnceMessageV2Extension ||
        content.imageMessage?.viewOnce === true || content.videoMessage?.viewOnce === true ||
        content.audioMessage?.viewOnce === true) return true;
    content = (content.ephemeralMessage || content.deviceSentMessage)?.message;
  }
  return false;
}

export function getInnerMediaType(innerContent) {
  if (!innerContent) return null;
  if (innerContent.imageMessage) return 'image';
  if (innerContent.videoMessage) return 'video';
  if (innerContent.audioMessage) return 'audio';
  if (innerContent.documentMessage) return 'document';
  return null;
}
