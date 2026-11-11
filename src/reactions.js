import { log } from './utils.js';

export const reactionStats = { count: 0, last: null };

export function handleReaction(msg) {
  try {
    const reaction = msg.message?.reactionMessage;
    if (!reaction) return;

    const emoji = reaction.text || '';
    const targetId = reaction.key?.id;
    const sender = msg.key.participant || msg.key.remoteJid;
    const chat = msg.key.remoteJid;

    reactionStats.count++;
    reactionStats.last = {
      emoji,
      targetMessageId: targetId,
      reactionMessageId: msg.key.id,
      sender,
      chat,
      timestamp: new Date().toISOString(),
    };

    log(`REACTION detected: ${emoji}`, `target=${targetId} from=${sender}`);
  } catch {}
}

export async function sendReaction(sock, jid, targetKey, emoji) {
  await sock.sendMessage(jid, {
    react: { text: emoji, key: targetKey },
  });
}
