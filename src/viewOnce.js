import fs from 'fs';
import path from 'path';
import { downloadMediaMessage, getUrlFromDirectPath, proto } from '@whiskeysockets/baileys';
import { config } from './config.js';
import { logViewOnce } from './diagnostics.js';
import {
  log, safeName, getMediaExt, ensureDir, unwrapMessageContent, getInnerMediaType,
} from './utils.js';

export const viewOnceStats = { count: 0, last: null };
const viewOnceStore = new Map();
const pendingRecoveries = new Map();
const RECOVERY_TIMEOUT_MS = 15000;

function storeKey(chat, id) {
  return `${chat}\0${id}`;
}

export function getStoredViewOnce(chat, id) {
  return viewOnceStore.get(storeKey(chat, id)) || null;
}

export function hasDownloadableMedia(msg) {
  const inner = unwrapMessageContent(msg?.message);
  const type = getInnerMediaType(inner);
  const media = inner?.[`${type}Message`];
  return !!(media?.mediaKey?.length && (media.url || media.directPath));
}

export async function handleViewOnce(sock, msg) {
  const chat = msg.key.remoteJid;
  const id = msg.key.id;
  const key = storeKey(chat, id);
  const previous = viewOnceStore.get(key);
  if (hasDownloadableMedia(previous) && !hasDownloadableMedia(msg)) return;

  viewOnceStore.set(key, msg);
  if (viewOnceStore.size > 200) viewOnceStore.delete(viewOnceStore.keys().next().value);
  if (!previous) viewOnceStats.count++;

  const inner = unwrapMessageContent(msg.message);
  const mediaType = getInnerMediaType(inner);
  const downloadable = hasDownloadableMedia(msg);
  viewOnceStats.last = {
    messageId: id, chat, mediaType, downloadable,
    timestamp: new Date().toISOString(),
  };

  const entry = {
    event: downloadable ? 'media_available' : 'placeholder_seen',
    messageId: id, mediaType,
    hasMediaKey: !!inner?.[`${mediaType}Message`]?.mediaKey?.length,
    hasMediaLocation: !!(inner?.[`${mediaType}Message`]?.url || inner?.[`${mediaType}Message`]?.directPath),
  };
  log('VIEW ONCE', `event=${entry.event} id=${id} type=${mediaType || 'unknown'}`);
  logViewOnce(entry);
  if (downloadable) pendingRecoveries.get(key)?.finish({ ok: true, message: msg });

  if (config.viewOnceTest && downloadable && !hasDownloadableMedia(previous)) {
    await runViewOnceDownloadTest(sock, msg, inner, mediaType, entry);
  }
}

export function inspectResendResponse(msg) {
  if (!pendingRecoveries.size) return;
  const protocol = unwrapMessageContent(msg.message)?.protocolMessage;
  if (!protocol) return;
  const response = protocol.peerDataOperationRequestResponseMessage;
  const recovery = response?.stanzaId
    ? [...pendingRecoveries.values()].find(item => item.requestId === response.stanzaId)
    : null;
  const matched = !!(recovery && msg.key.fromMe &&
    protocol.type === proto.Message.ProtocolMessage.Type.PEER_DATA_OPERATION_REQUEST_RESPONSE_MESSAGE &&
    response.peerDataOperationRequestType === proto.Message.PeerDataOperationRequestType.PLACEHOLDER_MESSAGE_RESEND);
  const results = response?.peerDataOperationResult || [];
  const entry = {
    event: 'phone_protocol', protocolType: protocol.type ?? null,
    operation: response?.peerDataOperationRequestType ?? null,
    requestId: response?.stanzaId || null, fromMe: !!msg.key.fromMe,
    matched, resultCount: results.length,
  };
  log('VIEW ONCE', JSON.stringify(entry));
  logViewOnce(entry);
  if (matched) recovery.phoneResponse = results.length ? 'no_media_bytes' : 'empty_results';

  results.forEach((result, index) => {
    const bytes = result.placeholderMessageResendResponse?.webMessageInfoBytes;
    const detail = {
      event: 'phone_result', requestId: response?.stanzaId || null, index, matched,
      fields: Object.keys(result), byteLength: bytes?.length || 0,
      mediaUploadResult: result.mediaUploadResult ?? null,
    };
    if (bytes?.length) {
      try {
        const decoded = proto.WebMessageInfo.decode(bytes);
        const inner = unwrapMessageContent(decoded.message);
        detail.decoded = true;
        detail.contentTypes = Object.keys(inner || {});
        detail.downloadable = hasDownloadableMedia(decoded);
        detail.stubType = decoded.messageStubType ?? null;
        detail.matchesMessageId = !!recovery && decoded.key?.id === recovery.originalKey.id;
        detail.matchesChat = !!recovery && decoded.key?.remoteJid === recovery.originalKey.remoteJid;
        if (matched) recovery.phoneResponse = detail.matchesMessageId
          ? detail.downloadable ? 'downloadable_payload' : 'payload_without_media'
          : 'different_message_id';
      } catch {
        detail.decoded = false;
        if (matched) recovery.phoneResponse = 'decode_failed';
      }
    }
    log('VIEW ONCE', JSON.stringify(detail));
    logViewOnce(detail);
  });
}

export function inspectResendUpdates(updates) {
  for (const update of updates) {
    const recovery = [...pendingRecoveries.values()].find(item => item.requestId && item.requestId === update.key?.id);
    if (!recovery || update.update?.status !== proto.WebMessageInfo.Status.ERROR) continue;
    const rawCode = update.update.messageStubParameters?.[0];
    const code = /^\d+$/.test(String(rawCode)) ? String(rawCode) : 'unknown';
    recovery.finish({ ok: false, event: 'request_rejected', reason: `WhatsApp reported an error for the resend request (code ${code}). No media was recovered.` });
  }
}

export function recoverViewOnce(sock, originalMsg) {
  const { remoteJid, id, fromMe, participant } = originalMsg.key;
  const key = storeKey(remoteJid, id);
  const stored = viewOnceStore.get(key) || originalMsg;
  if (hasDownloadableMedia(stored)) return Promise.resolve({ ok: true, message: stored });
  if (pendingRecoveries.has(key)) return pendingRecoveries.get(key).promise;

  let finish;
  const promise = new Promise(resolve => { finish = resolve; });
  const timer = setTimeout(() => {
    const recovery = pendingRecoveries.get(key);
    const observation = recovery?.phoneResponse
      ? `A matching phone reply was observed: ${recovery.phoneResponse}.`
      : 'No matching phone reply was observed.';
    recovery?.finish({
      ok: false,
      reason: `No downloadable media was recovered within 15 seconds. ${observation} Retrieval is not confirmed. Please share the VIEW ONCE diagnostic lines.`,
      event: 'recovery_timeout',
    });
  }, RECOVERY_TIMEOUT_MS);
  pendingRecoveries.set(key, {
    promise, originalKey: originalMsg.key, requestId: null, phoneResponse: null,
    finish(result) {
      if (pendingRecoveries.get(key)?.promise !== promise) return;
      clearTimeout(timer);
      pendingRecoveries.delete(key);
      if (!result.ok) {
        log('VIEW ONCE', `event=${result.event} id=${id}`);
        logViewOnce({ event: result.event, messageId: id });
      }
      finish(result);
    },
  });

  const requestMessage = { ...stored, key: { ...stored.key, isViewOnce: true } };
  viewOnceStore.set(key, requestMessage);
  if (viewOnceStore.size > 200) viewOnceStore.delete(viewOnceStore.keys().next().value);
  log('VIEW ONCE', `event=resend_requested id=${id}`);
  logViewOnce({ event: 'resend_requested', messageId: id });

  // The library restores this metadata onto the phone's response before emitting an upsert.
  const recovery = pendingRecoveries.get(key);
  Promise.resolve().then(() => sock.requestPlaceholderResend(
    { remoteJid, id, fromMe: !!fromMe, ...(participant ? { participant } : {}) },
    requestMessage,
  )).then(requestId => {
    recovery.requestId = requestId && requestId !== 'RESOLVED' ? requestId : null;
    log('VIEW ONCE', `event=resend_dispatched id=${id} request=${requestId || 'already_pending'}`);
  }).catch(err => recovery.finish({
    ok: false, reason: `Could not request the message from the phone: ${err.message}`,
    event: 'resend_failed',
  }));
  return promise;
}

export async function runViewOnceDownloadTest(sock, originalMsg, inner, mediaType, entry) {
  const result = await downloadViewOnceForVV(sock, originalMsg);
  if (!result.ok) {
    logViewOnce({ ...entry, event: 'diagnostic_failed', reason: result.reason });
    return;
  }
  ensureDir(config.viewOnceDir);
  const filename = safeName(`vo_${mediaType}`, getMediaExt(mediaType));
  fs.writeFileSync(path.join(config.viewOnceDir, filename), result.buffer);
  log('VIEW ONCE diagnostic', `downloaded_ok file=${filename} bytes=${result.buffer.length}`);
  logViewOnce({ ...entry, event: 'diagnostic_downloaded', bytes: result.buffer.length, filename });
}

export async function downloadViewOnceForVV(sock, originalMsg) {
  const inner = unwrapMessageContent(originalMsg.message);
  const mediaType = getInnerMediaType(inner);
  if (!hasDownloadableMedia(originalMsg)) {
    return { ok: false, reason: 'The message has no downloadable media location and key.' };
  }
  try {
    const media = inner[`${mediaType}Message`];
    const downloadMessage = {
      ...originalMsg,
      message: { [`${mediaType}Message`]: {
        ...media, url: media.url || getUrlFromDirectPath(media.directPath),
      } },
    };
    const buffer = await downloadMediaMessage(downloadMessage, 'buffer', { options: { signal: AbortSignal.timeout(30000) } }, {
      logger: { info: () => {}, error: () => {}, warn: () => {}, debug: () => {} },
      reuploadRequest: sock.updateMediaMessage,
    });
    if (!buffer.length) return { ok: false, reason: 'WhatsApp returned an empty media file.' };
    log('VIEW ONCE', `event=downloaded id=${originalMsg.key.id} type=${mediaType} bytes=${buffer.length}`);
    logViewOnce({ event: 'downloaded', messageId: originalMsg.key.id, mediaType, bytes: buffer.length });
    return { ok: true, buffer, mediaType, inner };
  } catch (err) {
    logViewOnce({ event: 'download_failed', messageId: originalMsg.key.id, reason: err.message });
    return { ok: false, reason: err.message };
  }
}
