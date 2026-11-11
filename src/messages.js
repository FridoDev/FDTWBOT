import { config } from './config.js';
import { handleCommand } from './commands.js';
import { handleViewOnce, getStoredViewOnce, inspectResendResponse, inspectResendUpdates } from './viewOnce.js';
import { handleReaction } from './reactions.js';
import { handleNormalMedia } from './media.js';
import { trackMessage, handleMessageUpdate } from './deletedMessages.js';
import { log, isViewOnce, unwrapMessageContent } from './utils.js';
import { botState } from './whatsapp.js';

export function registerMessageHandlers(sock) {
  const getSelfJid = () => {
    if (config.selfJid) return config.selfJid;
    if (botState.account) return `${botState.account.replace(/\D/g, '')}@s.whatsapp.net`;
    return null;
  };

  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    log('UPSERT', `type=${type} count=${messages.length}`);
    await Promise.all(messages.map(async msg => {
      try {
        await processMessage(sock, msg, type === 'notify');
      } catch (err) {
        log('ERROR processing message', err.message);
      }
    }));
  });

  sock.ev.on('messages.update', async (updates) => {
    try {
      inspectResendUpdates(updates);
      for (const update of updates) {
        if (update.update?.message && update.key) {
          const fullMsg = {
            key: update.key,
            message: update.update.message,
            messageTimestamp: update.update.messageTimestamp,
            pushName: update.update.pushName,
          };
          await processMessage(sock, fullMsg, false).catch(err =>
            log('ERROR processing resent message', err.message)
          );
        }
      }
      await handleMessageUpdate(updates, sock, getSelfJid());
    } catch (err) {
      log('ERROR processing message update', err.message);
    }
  });
}

async function processMessage(sock, msg, allowCommands = true) {
  const jid = msg.key.remoteJid;
  if (jid === 'status@broadcast') return;
  inspectResendResponse(msg);

  if (msg.key.isViewOnce || isViewOnce(msg.message) || getStoredViewOnce(jid, msg.key.id)) {
    await handleViewOnce(sock, msg);
    return;
  }
  if (!msg.message || !allowCommands) return;

  botState.msgCount++;
  trackMessage(msg);

  const msgContent = unwrapMessageContent(msg.message);
  const sender = msg.key.participant || jid;

  // Reactions
  if (msgContent.reactionMessage) {
    handleReaction(msg);
    return;
  }

  // Extract text for commands
  const text =
    msgContent.conversation ||
    msgContent.extendedTextMessage?.text ||
    '';

  log('MESSAGE received', `from=${sender} jid=${jid} type=${getType(msgContent)}`);

  // Normal media download (diagnostic mode only, never for statuses)
  if (config.diagnosticMode) {
    const mediaKeys = ['imageMessage','videoMessage','audioMessage','documentMessage','stickerMessage'];
    const foundType = Object.keys(msgContent).find(t => mediaKeys.includes(t));
    if (foundType) {
      const mediaType = foundType.replace('Message', '');
      await handleNormalMedia(sock, msg, mediaType);
    }
  }

  // Commands
  if (text.startsWith('.')) {
    await handleCommand(sock, msg, text);
  }
}

function getType(msgContent) {
  const keys = ['conversation','extendedTextMessage','imageMessage','videoMessage','audioMessage',
    'documentMessage','stickerMessage','reactionMessage','viewOnceMessage','viewOnceMessageV2'];
  return keys.find(k => msgContent[k]) || Object.keys(msgContent).join(',') || 'empty';
}
