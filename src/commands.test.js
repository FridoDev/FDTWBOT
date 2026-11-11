import test from 'node:test';
import assert from 'node:assert/strict';
import { handleCommand } from './commands.js';
import { registerMessageHandlers } from './messages.js';
import { botState } from './whatsapp.js';
import { config } from './config.js';
import { viewOnceStats } from './viewOnce.js';
import { reactionStats } from './reactions.js';
import { deletionStats } from './deletedMessages.js';
import { normalMediaStats } from './media.js';

const self = '1111111111@s.whatsapp.net';
const lid = '3333333333@lid';
const utilities = ['.alive', '.help', '.ping', '.status', '.self', '.sendtest', '.diagnostic', '.viewonce', '.vvinfo', '.reaction', '.reactions', '.deleted', '.last', '.media', '.media on', '.media off'];
function fixture(t) {
  const saved = [botState, config, viewOnceStats, reactionStats, deletionStats, normalMediaStats].map(object => [object, { ...object }]);
  t.after(() => { for (const [object, state] of saved) Object.assign(object, state); });
  const handlers = new Map();
  const sock = {
    user: { id: '1111111111:7@s.whatsapp.net', lid: '3333333333:7@lid' }, sent: [],
    ev: { on(event, fn) { handlers.set(event, fn); } },
    async emit(event, data) { await handlers.get(event)?.(data); },
    async sendMessage(jid, payload, options) {
      this.sent.push({ jid, payload, options });
      return { key: { id: `reply-${this.sent.length}`, remoteJid: jid, fromMe: true } };
    },
  };
  return sock;
}
const message = (text, overrides = {}) => ({ key: { remoteJid: self, fromMe: true, id: 'command-fixture', ...overrides }, message: { conversation: text } });

test('alive and test aliases produce one branded private response', async t => {
  for (const cmd of ['.alive', '.self', '.sendtest', '  .ALIVE  ']) {
    const sock = fixture(t);
    await handleCommand(sock, message(cmd), cmd);
    assert.equal(sock.sent.length, 1);
    assert.equal(sock.sent[0].jid, self);
    assert.match(sock.sent[0].payload.text, /YES BOSS\. FRIDO DEV BOT IS ACTIVE/);
    assert.match(sock.sent[0].payload.text, /FRIDO DEV TECH.*Created by FRIDO/);
    assert.match(sock.sent[0].payload.text, /Runtime uptime: \d+h \d+m \d+s/);
  }
});

test('private utilities accept both normalized phone and LID self-chat identities', async t => {
  const sock = fixture(t);
  for (const remoteJid of [self, '1111111111:3@s.whatsapp.net', lid, '3333333333:9@lid']) {
    await handleCommand(sock, message('.alive', { remoteJid }), '.alive');
  }
  assert.equal(sock.sent.length, 4);
  assert.equal(sock.sent[2].jid, lid);
});

test('every utility ignores foreign messages, other chats and groups without changing settings', async t => {
  const sock = fixture(t);
  config.normalMediaMode = false;
  for (const cmd of utilities) {
    for (const key of [
      { fromMe: false },
      { remoteJid: '2222222222@s.whatsapp.net', fromMe: false },
      { remoteJid: '2222222222@s.whatsapp.net', fromMe: true },
      { remoteJid: '1111111111@g.us', fromMe: true },
      { remoteJid: 'status@broadcast', fromMe: true },
    ]) await handleCommand(sock, message(cmd, key), cmd);
  }
  assert.equal(sock.sent.length, 0);
  assert.equal(config.normalMediaMode, false);
});

test('private utility access cannot fall back to a configured unrelated self JID', async t => {
  const sock = fixture(t);
  sock.user = undefined;
  config.selfJid = self;
  await handleCommand(sock, message('.help'), '.help');
  assert.equal(sock.sent.length, 0);
});

test('help documents all utilities, retrieval aliases, restrictions and setting limitations', async t => {
  const sock = fixture(t);
  await handleCommand(sock, message('.help'), '.help');
  const help = sock.sent[0].payload.text;
  for (const command of [...utilities, '.vv', '.vvtest', '.👍', '.👎', '.💚', '.❤️', '.😊']) assert.ok(help.includes(command), command);
  assert.match(help, /ignored outside your self-chat/);
  assert.match(help, /Retrieval commands remain available to you in other chats/);
  assert.match(help, /diagnostic mode must also be enabled/);
});

test('ping waits for its send to complete then edits that message with a measured duration', async t => {
  const sock = fixture(t);
  let finish;
  const original = sock.sendMessage;
  sock.sendMessage = async function (...args) {
    const sent = await original.apply(this, args);
    if (this.sent.length === 1) return new Promise(resolve => { finish = () => resolve(sent); });
    return sent;
  };
  const pending = handleCommand(sock, message('.ping'), '.ping');
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(sock.sent.length, 1);
  assert.doesNotMatch(sock.sent[0].payload.text, /PONG/);
  finish();
  await pending;
  assert.equal(sock.sent.length, 2);
  assert.equal(sock.sent[1].payload.edit.id, 'reply-1');
  assert.match(sock.sent[1].payload.text, /Send completion: \d+ ms/);
  assert.match(sock.sent[1].payload.text, /not network round-trip time or delivery confirmation/);
});

test('ping does not report a successful measurement when the send fails or returns no ID', async t => {
  const sock = fixture(t);
  sock.sendMessage = async () => { throw new Error('send failed'); };
  await assert.rejects(handleCommand(sock, message('.ping'), '.ping'), /send failed/);
  let calls = 0;
  sock.sendMessage = async () => { calls++; return {}; };
  await handleCommand(sock, message('.ping'), '.ping');
  assert.equal(calls, 1);
});

test('status reports actual runtime state and counters, not invented connection metrics', async t => {
  const sock = fixture(t);
  Object.assign(botState, { status: 'reconnecting', msgCount: 17, account: 'private-account' });
  viewOnceStats.count = 3;
  reactionStats.count = 4;
  deletionStats.count = 2;
  normalMediaStats.count = 5;
  await handleCommand(sock, message('.status'), '.status');
  const text = sock.sent[0].payload.text;
  for (const line of ['Connection: reconnecting', 'Messages processed: 17', 'View-once observed: 3', 'Deletions observed: 2', 'Reactions observed: 4', 'Normal media observed: 5']) assert.ok(text.includes(line));
  assert.match(text, /uptime is not connected duration/);
  assert.doesNotMatch(text, /private-account/);
});

test('event commands handle empty statistics without claiming recovery or activity', async t => {
  const sock = fixture(t);
  for (const stats of [viewOnceStats, reactionStats, deletionStats]) Object.assign(stats, { count: 0, last: null });
  for (const cmd of ['.vvinfo', '.reactions', '.deleted', '.last']) await handleCommand(sock, message(cmd), cmd);
  assert.equal(sock.sent.length, 4);
  for (const sent of sock.sent) assert.match(sent.payload.text, /No .*observed yet/);
  assert.match(sock.sent[2].payload.text, /does not recover deleted content/);
});

test('event reports select the latest observation and never dump message payloads', async t => {
  const sock = fixture(t);
  const privateFields = { mediaKey: 'DO-NOT-LEAK', chat: 'PRIVATE-CHAT', raw: 'PRIVATE-BODY' };
  viewOnceStats.last = { ...privateFields, mediaType: 'image', downloadable: true, timestamp: '2026-11-11T10:00:00.000Z' };
  reactionStats.last = { ...privateFields, emoji: '+1', timestamp: '2026-11-11T10:02:00.000Z' };
  deletionStats.last = { ...privateFields, timestamp: '2026-11-11T10:01:00.000Z' };
  for (const cmd of ['.vvinfo', '.reactions', '.deleted', '.last', '.diagnostic']) await handleCommand(sock, message(cmd), cmd);
  assert.match(sock.sent[3].payload.text, /Latest tracked event: REACTION/);
  for (const sent of sock.sent) assert.doesNotMatch(sent.payload.text, /DO-NOT-LEAK|PRIVATE-CHAT|PRIVATE-BODY/);
});

test('media control is explicit, process-local and does not enable diagnostic processing', async t => {
  const sock = fixture(t);
  config.normalMediaMode = false;
  config.diagnosticMode = false;
  await handleCommand(sock, message('.media on'), '.media on');
  assert.equal(config.normalMediaMode, true);
  assert.equal(config.diagnosticMode, false);
  assert.match(sock.sent[0].payload.text, /Both must be ON/);
  await handleCommand(sock, message('.media'), '.media');
  assert.equal(config.normalMediaMode, true);
  await handleCommand(sock, message('.media off'), '.media off');
  assert.equal(config.normalMediaMode, false);
});

test('live self-chat upserts execute utilities while history and bot replies never loop', async t => {
  const sock = fixture(t);
  registerMessageHandlers(sock);
  await sock.emit('messages.upsert', { type: 'append', messages: [message('.alive')] });
  assert.equal(sock.sent.length, 0);
  await sock.emit('messages.upsert', { type: 'notify', messages: [message('.alive')] });
  assert.equal(sock.sent.length, 1);
  await sock.emit('messages.upsert', { type: 'notify', messages: [message(sock.sent[0].payload.text, { id: 'bot-reply' })] });
  assert.equal(sock.sent.length, 1);
});
