import { areJidsSameUser, jidNormalizedUser } from '@whiskeysockets/baileys';
import { config } from './config.js';
import { viewOnceStats, downloadViewOnceForVV, getStoredViewOnce, recoverViewOnce, hasDownloadableMedia } from './viewOnce.js';
import { reactionStats } from './reactions.js';
import { deletionStats } from './deletedMessages.js';
import { normalMediaStats } from './media.js';
import { log, unwrapMessageContent } from './utils.js';
import { logViewOnce } from './diagnostics.js';
import { botState } from './whatsapp.js';

const VIEW_ONCE_COMMANDS = new Set(['.vv', '.vvtest', '.👍', '.👎', '.💚', '.❤', '.😊']);

const HELP_TEXT = `
*FRIDO DEV BOT*
\`// COMMAND DIRECTORY\`

*CORE / VIEW-ONCE*
Reply to media with .👍 .👎 .💚 .❤️ or .😊
The bot sends it to your self-chat, then reacts 💚 to the original after a successful send.
.vv / .vvtest — same retrieval, same owner-only protection.
Only retrieve media you have permission to retain. Availability depends on WhatsApp and the original media.

*PRIVATE / SEND IN YOUR SELF-CHAT*
.alive — check that the bot responds
.ping — measure message-send completion time
.status — connection, runtime uptime and counters
.help — this command directory
.vvinfo — observed view-once count and latest arrival
.reactions — latest observed reaction
.deleted — deletion-event count and latest time; not a recovery command
.last — latest tracked view-once, reaction or deletion event
.media — normal-media download settings
.diagnostic — runtime diagnostic settings

*ADVANCED / SELF-CHAT ONLY*
.media on / .media off — toggle normal-media downloads for this process; diagnostic mode must also be enabled. View-once retrieval is independent.

*ALIASES*
.self / .sendtest → .alive
.viewonce → .vvinfo
.reaction → .reactions

Counters reset when the process restarts. Utility commands are ignored outside your self-chat. Retrieval commands remain available to you in other chats.

*FRIDO DEV TECH* • Created by FRIDO
`.trim();

function techReply(title, lines) {
  return `*FRIDO DEV BOT*\n\`// ${title}\`\n\n${lines.join('\n')}\n\n*FRIDO DEV TECH* • Created by FRIDO`;
}

function runtimeUptime() {
  const seconds = Math.floor(process.uptime());
  return `${Math.floor(seconds / 3600)}h ${Math.floor(seconds % 3600 / 60)}m ${seconds % 60}s`;
}

export async function handleCommand(sock, msg, text) {
  const jid = msg.key.remoteJid;
  const cmd = text.trim().toLowerCase();
  if (VIEW_ONCE_COMMANDS.has(cmd.replace(/[\uFE0E\uFE0F]/g, ''))) {
    await handleVV(sock, msg, jid);
    return;
  }
  if (!msg.key.fromMe || ![sock.user?.id, sock.user?.lid].some(
    ownJid => ownJid && jidNormalizedUser(jid) === jidNormalizedUser(ownJid)
  )) return;

  const reply = body => sock.sendMessage(jid, { text: body }, { quoted: msg });

  if (cmd === '.help') {
    await reply(HELP_TEXT);
  } else if (['.alive', '.self', '.sendtest'].includes(cmd)) {
    await reply(techReply('SYSTEM RESPONSE', [
      '*YES BOSS. FRIDO DEV BOT IS ACTIVE.*',
      `Runtime uptime: ${runtimeUptime()}`,
      'Access: OWNER / SELF-CHAT',
      'Command directory: .help',
    ]));
  } else if (cmd === '.ping') {
    const start = performance.now();
    const sent = await reply(techReply('PING', ['Measuring message-send completion…']));
    if (!sent?.key?.id) return;
    const elapsed = Math.max(0, Math.round(performance.now() - start));
    await sock.sendMessage(jid, {
      text: techReply('PONG', [`Send completion: ${elapsed} ms`, 'Measured locally; not network round-trip time or delivery confirmation.']),
      edit: sent.key,
    });
  } else if (cmd === '.status') {
    await reply(techReply('RUNTIME STATUS', [
      `Connection: ${botState.status}`,
      `Runtime uptime: ${runtimeUptime()}`,
      `Messages processed: ${botState.msgCount}`,
      `View-once observed: ${viewOnceStats.count}`,
      `Deletions observed: ${deletionStats.count}`,
      `Reactions observed: ${reactionStats.count}`,
      `Normal media observed: ${normalMediaStats.count}`,
      'Counters cover this process only; uptime is not connected duration.',
    ]));
  } else if (cmd === '.diagnostic') {
    await reply(techReply('DIAGNOSTICS', [
      `Diagnostic processing: ${config.diagnosticMode ? 'ON' : 'OFF'}`,
      `Normal-media downloads: ${config.normalMediaMode ? 'ON' : 'OFF'}`,
      `Automatic view-once test: ${config.viewOnceTest ? 'ON' : 'OFF'}`,
      'View-once reply commands work independently of normal-media settings.',
    ]));
  } else if (cmd === '.viewonce' || cmd === '.vvinfo') {
    const last = viewOnceStats.last;
    await reply(techReply('VIEW-ONCE INTEL', [
      `Observed this process: ${viewOnceStats.count}`,
      ...(last ? [
        `Latest type: ${last.mediaType || 'placeholder'}`,
        `Latest arrival contained media: ${last.downloadable ? 'YES' : 'NO'}`,
        `Observed at (UTC): ${last.timestamp}`,
      ] : ['No view-once messages observed yet.']),
      'This reports observations, not guaranteed media availability.',
    ]));
  } else if (cmd === '.reaction' || cmd === '.reactions') {
    const last = reactionStats.last;
    await reply(techReply('REACTION INTEL', [
      `Observed this process: ${reactionStats.count}`,
      ...(last ? [`Latest reaction: ${last.emoji || '(removed)'}`, `Observed at (UTC): ${last.timestamp}`] : ['No reactions observed yet.']),
    ]));
  } else if (cmd === '.deleted') {
    await reply(techReply('DELETION INTEL', [
      `Observed this process: ${deletionStats.count}`,
      deletionStats.last ? `Latest event (UTC): ${deletionStats.last.timestamp}` : 'No deletion events observed yet.',
      'Event metadata only; this command does not recover deleted content.',
    ]));
  } else if (cmd === '.last') {
    const latest = [
      { kind: 'VIEW-ONCE', event: viewOnceStats.last },
      { kind: 'REACTION', event: reactionStats.last },
      { kind: 'DELETION', event: deletionStats.last },
    ].filter(item => item.event).sort((a, b) => b.event.timestamp.localeCompare(a.event.timestamp))[0];
    await reply(techReply('EVENT INSPECTOR', latest
      ? [`Latest tracked event: ${latest.kind}`, `Observed at (UTC): ${latest.event.timestamp}`]
      : ['No view-once, reaction or deletion events observed yet.']));
  } else if (['.media', '.media on', '.media off'].includes(cmd)) {
    if (cmd !== '.media') config.normalMediaMode = cmd === '.media on';
    await reply(techReply('MEDIA CONTROL', [
      `Normal-media downloads: ${config.normalMediaMode ? 'ON' : 'OFF'}`,
      `Diagnostic processing: ${config.diagnosticMode ? 'ON' : 'OFF'}`,
      'Both must be ON to download normal media. Changes last for this process only.',
      'View-once reply commands are unchanged.',
    ]));
  }
}

async function handleVV(sock, msg, jid) {
  if (!msg.key.fromMe) return;
  const selfJid = getSelfJid(sock);
  if (!selfJid) {
    log('VIEW ONCE', 'Cannot determine the owner inbox; reconnect before retrying.');
    return;
  }
  const notifyOwner = body => sock.sendMessage(selfJid, { text: body });
  const context = unwrapMessageContent(msg.message)?.extendedTextMessage?.contextInfo;
  const quotedId = context?.stanzaId;
  if (!quotedId) {
    await notifyOwner('Reply to a view-once message with .👍, .👎, .💚, .❤️ or .😊. Test only media you have permission to retain.');
    return;
  }

  const cached = getStoredViewOnce(jid, quotedId);
  const quoted = {
    key: cached?.key || {
      remoteJid: jid,
      id: quotedId,
      participant: context.participant,
      fromMe: !!context.participant && [sock.user?.id, sock.user?.lid]
        .some(ownJid => ownJid && areJidsSameUser(context.participant, ownJid)),
    },
    message: context.quotedMessage,
  };
  const cacheReady = hasDownloadableMedia(cached);
  const quoteReady = hasDownloadableMedia(quoted);
  const source = cacheReady ? 'cache' : quoteReady ? 'quote' : 'phone_resend';
  const quotedContent = unwrapMessageContent(context.quotedMessage);
  const quotedMedia = quotedContent?.imageMessage || quotedContent?.videoMessage || quotedContent?.audioMessage;
  const quoteHasKey = !!quotedMedia?.mediaKey?.length;
  const quoteHasLocation = !!(quotedMedia?.url || quotedMedia?.directPath);
  log('VIEW ONCE', `event=source_selected id=${quotedId} source=${source} cachedMedia=${cacheReady} quotedMedia=${quoteReady} quoteHasKey=${quoteHasKey} quoteHasLocation=${quoteHasLocation}`);
  logViewOnce({ event: 'source_selected', messageId: quotedId, source, cacheReady, quoteReady, quoteHasKey, quoteHasLocation });
  let original = cacheReady ? cached : quoteReady ? quoted : cached || quoted;
  if (!hasDownloadableMedia(original)) {
    const recovered = await recoverViewOnce(sock, original);
    if (!recovered.ok) {
      await notifyOwner(recovered.reason);
      return;
    }
    original = recovered.message;
  }

  const result = await downloadViewOnceForVV(sock, original);
  if (!result.ok) {
    await notifyOwner(`Could not retrieve media: ${result.reason}`);
    return;
  }

  const media = result.inner[`${result.mediaType}Message`];
  const payload = result.mediaType === 'audio'
    ? { audio: result.buffer, mimetype: media.mimetype || 'audio/ogg; codecs=opus', ptt: !!media.ptt }
    : result.mediaType === 'document'
      ? { document: result.buffer, fileName: 'view-once-media', mimetype: media.mimetype || 'application/octet-stream' }
      : { [result.mediaType]: result.buffer, caption: '[View Once retrieved]' };
  try {
    const sent = await sock.sendMessage(selfJid, payload);
    if (!sent?.key?.id) throw new Error('No sent-message ID was returned.');
    log('VIEW ONCE', `event=sent_to_self id=${quotedId} type=${result.mediaType} bytes=${result.buffer.length} sentId=${sent.key.id}`);
    logViewOnce({ event: 'sent_to_self', messageId: quotedId, sentMessageId: sent.key.id, mediaType: result.mediaType, bytes: result.buffer.length });
  } catch (err) {
    logViewOnce({ event: 'send_failed', messageId: quotedId, reason: err.message });
    await notifyOwner(`Downloaded the media, but sending to your inbox failed: ${err.message}`);
    return;
  }
  try {
    await sock.sendMessage(jid, { react: {
      text: '💚',
      key: {
        remoteJid: jid, id: quotedId, fromMe: !!original.key.fromMe,
        ...(original.key.participant ? { participant: original.key.participant } : {}),
      },
    } });
    logViewOnce({ event: 'confirmation_reaction_sent', messageId: quotedId });
  } catch (err) {
    logViewOnce({ event: 'reaction_failed', messageId: quotedId, reason: err.message });
    await notifyOwner(`The media was sent to your self-chat, but the confirmation reaction failed: ${err.message}`);
  }
}

function getSelfJid(sock) {
  if (sock.user?.id) return jidNormalizedUser(sock.user.id);
  if (config.selfJid) return config.selfJid;
  if (botState.account) {
    const num = botState.account.split('@')[0].split(':')[0];
    return `${num}@s.whatsapp.net`;
  }
  return null;
}
