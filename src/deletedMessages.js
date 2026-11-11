import { logDeletion } from './diagnostics.js';
import { log } from './utils.js';

export const deletionStats = { count: 0, last: null };

// Stores full message objects keyed by message ID so we can forward them on deletion
const seenMessages = new Map();

export function trackMessage(msg) {
  try {
    seenMessages.set(msg.key.id, {
      chat: msg.key.remoteJid,
      sender: msg.key.participant || msg.key.remoteJid,
      timestamp: msg.messageTimestamp,
      raw: msg, // keep the full message for forwarding
    });
    if (seenMessages.size > 5000) {
      const oldest = [...seenMessages.keys()][0];
      seenMessages.delete(oldest);
    }
  } catch {}
}

export async function handleMessageUpdate(updates, sock, selfJid) {
  for (const update of updates) {
    try {
      if (!update.update?.messageStubType) continue;
      const stubType = update.update.messageStubType;
      // REVOKE = 1
      if (stubType === 1 || String(stubType) === 'REVOKE') {
        const targetId = update.key?.id;
        const chat = update.key?.remoteJid;

        // Ignore status broadcast revocations — not relevant
        if (chat === 'status@broadcast') continue;
        const entry = seenMessages.get(targetId);
        const previouslySeen = !!entry;

        deletionStats.count++;
        deletionStats.last = { targetId, chat, timestamp: new Date().toISOString() };

        log('MESSAGE REVOCATION detected', `id=${targetId} chat=${chat} wasSeen=${previouslySeen}`);

        logDeletion({
          event: 'revoke',
          targetMessageId: targetId,
          chat,
          previouslySeen,
          originalMessage: entry ? { chat: entry.chat, sender: entry.sender, timestamp: entry.timestamp } : null,
        });

        // Forward the deleted message to self inbox if we saw it and have a socket
        if (previouslySeen && entry?.raw && sock && selfJid) {
          try {
            const raw = entry.raw;
            const senderNum = (raw.key.participant || raw.key.remoteJid || '').replace('@s.whatsapp.net', '').replace('@g.us', '');
            await sock.sendMessage(selfJid, {
              text: `🗑️ *Deleted message detected*\n*From:* +${senderNum}\n*Chat:* ${chat}\n*Time:* ${new Date(Number(raw.messageTimestamp) * 1000).toLocaleString()}`,
            });
            // Forward the actual message content
            await sock.sendMessage(selfJid, { forward: raw });
            log('DELETION forwarded to inbox', selfJid);
          } catch (err) {
            log('DELETION forward failed', err.message);
          }
        }
      }
    } catch {}
  }
}
