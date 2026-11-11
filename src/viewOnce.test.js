import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { createCipheriv, createHmac, randomBytes } from 'node:crypto';
import { getMediaKeys, proto } from '@whiskeysockets/baileys';
import { isViewOnce, extractViewOnceInner } from './utils.js';
import { config } from './config.js';

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'view-once-tests-'));
config.diagnosticsDir = temp;
config.viewOnceTest = false;
config.diagnosticMode = false;
config.normalMediaMode = false;
const { handleViewOnce, getStoredViewOnce, recoverViewOnce, downloadViewOnceForVV, hasDownloadableMedia } = await import('./viewOnce.js');
const { registerMessageHandlers } = await import('./messages.js');
const { handleCommand } = await import('./commands.js');
const { reactionStats } = await import('./reactions.js');

const responses = new Map();
const server = http.createServer((req, res) => {
  const payload = responses.get(req.url);
  res.writeHead(payload ? 200 : 500, { 'Content-Type': 'application/octet-stream' });
  res.end(payload || 'fixture error');
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
after(async () => {
  await new Promise(resolve => server.close(resolve));
  fs.rmSync(temp, { recursive: true, force: true });
});

let nextId = 0;
const chat = '2222222222@s.whatsapp.net';
function message(content, overrides = {}) {
  return { key: { remoteJid: chat, fromMe: false, id: `fixture-${++nextId}`, ...overrides }, ...(content ? { message: content } : {}) };
}
function socket() {
  const handlers = new Map();
  return {
    user: { id: '1111111111:7@s.whatsapp.net', lid: '3333333333:7@lid' },
    sent: [], requests: [],
    ev: { on(event, handler) { handlers.set(event, handler); } },
    async emit(event, data) { await handlers.get(event)?.(data); },
    async sendMessage(jid, payload) {
      this.sent.push({ jid, payload });
      return { key: { id: `sent-${this.sent.length}` } };
    },
    async requestPlaceholderResend(key, data) {
      this.requests.push({ key, data });
      return 'fixture-request';
    },
  };
}
async function fixture(type = 'image') {
  const plaintext = Buffer.from(`consented local ${type} fixture; not a real WhatsApp download`);
  const mediaKey = randomBytes(32);
  const { cipherKey, iv, macKey } = await getMediaKeys(mediaKey, type);
  const cipher = createCipheriv('aes-256-cbc', cipherKey, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const mac = createHmac('sha256', macKey).update(Buffer.concat([iv, ciphertext])).digest().subarray(0, 10);
  const route = `/fixture-${++nextId}`;
  responses.set(route, Buffer.concat([ciphertext, mac]));
  const media = { mediaKey, url: `http://127.0.0.1:${server.address().port}${route}`, viewOnce: true, mimetype: `${type}/${type === 'audio' ? 'ogg' : type === 'image' ? 'png' : 'mp4'}` };
  return { plaintext, media, content: { [`${type}Message`]: media } };
}
function command(original, fromMe = true) {
  return message({ extendedTextMessage: { text: '.vv', contextInfo: {
    stanzaId: original.key.id, participant: original.key.participant || original.key.remoteJid,
    quotedMessage: { viewOnceMessageV2: { message: { imageMessage: { viewOnce: true } } } },
  } } }, { remoteJid: original.key.remoteJid, fromMe });
}

for (const wrapper of ['viewOnceMessage', 'viewOnceMessageV2', 'viewOnceMessageV2Extension']) {
  test(`detects ${wrapper} inside ephemeral content`, () => {
    const inner = { imageMessage: { viewOnce: true } };
    const content = { ephemeralMessage: { message: { [wrapper]: { message: inner } } } };
    assert.equal(isViewOnce(content), true);
    assert.deepEqual(extractViewOnceInner(content), inner);
  });
}
for (const type of ['image', 'video', 'audio']) {
  test(`detects direct ${type} flag without classifying normal media`, () => {
    assert.equal(isViewOnce({ [`${type}Message`]: { viewOnce: true } }), true);
    assert.equal(isViewOnce({ [`${type}Message`]: {} }), false);
  });
  test(`real library decrypts local encrypted ${type} fixture byte-for-byte`, async () => {
    const data = await fixture(type);
    const result = await downloadViewOnceForVV(socket(), message({ ephemeralMessage: { message: { viewOnceMessageV2: { message: data.content } } } }));
    assert.equal(result.ok, true, result.reason);
    assert.equal(result.mediaType, type);
    assert.deepEqual(result.buffer, data.plaintext);
  });
}

test('caches empty view-once placeholders without automatically requesting media', async () => {
  const sock = socket();
  registerMessageHandlers(sock);
  const placeholder = message(null, { isViewOnce: true });
  await sock.emit('messages.upsert', { messages: [placeholder], type: 'notify' });
  assert.equal(getStoredViewOnce(chat, placeholder.key.id), placeholder);
  assert.equal(sock.requests.length, 0);
  assert.equal(sock.sent.length, 0);
});

test('owner command recovers a placeholder, downloads, and sends only to owner inbox', async () => {
  const sock = socket();
  registerMessageHandlers(sock);
  const data = await fixture();
  const original = message(null, { isViewOnce: true });
  await sock.emit('messages.upsert', { messages: [original], type: 'notify' });
  sock.requestPlaceholderResend = async (key, metadata) => {
    sock.requests.push({ key, metadata });
    assert.equal('isViewOnce' in key, false);
    await sock.emit('messages.upsert', { messages: [{ ...metadata, message: data.content }], type: 'notify' });
    return 'fixture-request';
  };
  await sock.emit('messages.upsert', { messages: [command(original)], type: 'notify' });
  assert.equal(sock.requests.length, 1);
  const media = sock.sent.find(s => s.payload.image);
  assert.equal(media.jid, '1111111111@s.whatsapp.net');
  assert.deepEqual(media.payload.image, data.plaintext);
  assert.equal(media.payload.viewOnce, undefined);
  assert.equal(sock.sent.length, 2);
  assert.equal(sock.sent[0], media);
  assert.deepEqual(sock.sent[1], { jid: chat, payload: { react: {
    text: '💚', key: { remoteJid: chat, id: original.key.id, fromMe: false },
  } } });
  assert.equal(sock.sent.some(s => s.payload.text), false);
});

test('usable quoted media takes priority over an empty cached placeholder', async () => {
  const sock = socket();
  const data = await fixture();
  const original = message(null, { isViewOnce: true });
  await handleViewOnce(sock, original);
  sock.requestPlaceholderResend = async () => {
    sock.requests.push('unexpected-resend');
    throw new Error('Usable quoted media was ignored');
  };
  const cmd = command(original);
  cmd.message.extendedTextMessage.contextInfo.quotedMessage = {
    viewOnceMessageV2: { message: data.content },
  };
  await handleCommand(sock, cmd, '.vv');
  assert.equal(sock.requests.length, 0);
  assert.deepEqual(sock.sent.find(s => s.payload.image)?.payload.image, data.plaintext);
});

test('stripped quote with no cached original requests the quoted message', async () => {
  const sock = socket();
  registerMessageHandlers(sock);
  const original = message(null);
  const data = await fixture('audio');
  sock.requestPlaceholderResend = async (key, metadata) => {
    sock.requests.push(key);
    await sock.emit('messages.upsert', { messages: [{ ...metadata, message: data.content }], type: 'notify' });
    return 'fixture-request';
  };
  const cmd = command(original);
  delete cmd.message.extendedTextMessage.contextInfo.quotedMessage;
  await handleCommand(sock, cmd, '.vv');
  assert.equal(sock.requests[0].id, original.key.id);
  assert.deepEqual(sock.sent.find(s => s.payload.audio).payload.audio, data.plaintext);
});

test('another account cannot trigger retrieval', async () => {
  const sock = socket();
  await handleCommand(sock, command(message(null), false), '.vv');
  assert.equal(sock.requests.length, 0);
  assert.equal(sock.sent.length, 0);
});

test('unquoted command has an actionable response and does not request anything', async () => {
  const sock = socket();
  await handleCommand(sock, message({ conversation: '.vv' }, { fromMe: true }), '.vv');
  assert.equal(sock.requests.length, 0);
  assert.equal(sock.sent.length, 1);
  assert.equal(sock.sent[0].jid, '1111111111@s.whatsapp.net');
  assert.match(sock.sent[0].payload.text, /Reply to a view-once/);
});

test('cache is scoped by chat and does not downgrade media to placeholders', async () => {
  const data = await fixture();
  const original = message(data.content);
  await handleViewOnce(socket(), original);
  assert.equal(getStoredViewOnce('other@g.us', original.key.id), null);
  await handleViewOnce(socket(), { key: { ...original.key, isViewOnce: true } });
  assert.equal(hasDownloadableMedia(getStoredViewOnce(chat, original.key.id)), true);
});

test('offline upserts cache media but never replay historical commands', async () => {
  const sock = socket();
  registerMessageHandlers(sock);
  const data = await fixture();
  const original = message(data.content);
  await sock.emit('messages.upsert', { messages: [original, command(original)], type: 'append' });
  assert.equal(hasDownloadableMedia(getStoredViewOnce(chat, original.key.id)), true);
  assert.equal(sock.sent.length, 0);
});

test('same-batch command and recovered media do not deadlock', async () => {
  const sock = socket();
  registerMessageHandlers(sock);
  const data = await fixture();
  const original = message(data.content);
  await sock.emit('messages.upsert', { messages: [command(original), original], type: 'notify' });
  assert.deepEqual(sock.sent.find(s => s.payload.image).payload.image, data.plaintext);
});

test('duplicate recovery requests are bounded and time out honestly', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const sock = socket();
  const original = message(null, { isViewOnce: true });
  const first = recoverViewOnce(sock, original);
  assert.equal(recoverViewOnce(sock, original), first);
  await Promise.resolve();
  t.mock.timers.tick(15000);
  const result = await first;
  assert.equal(sock.requests.length, 1);
  assert.equal(result.ok, false);
  assert.equal(result.event, 'recovery_timeout');
  assert.match(result.reason, /Retrieval is not confirmed/);
});

function phoneReply(results, overrides = {}) {
  return message({ protocolMessage: {
    type: proto.Message.ProtocolMessage.Type.PEER_DATA_OPERATION_REQUEST_RESPONSE_MESSAGE,
    peerDataOperationRequestResponseMessage: {
      stanzaId: 'fixture-request',
      peerDataOperationRequestType: proto.Message.PeerDataOperationRequestType.PLACEHOLDER_MESSAGE_RESEND,
      peerDataOperationResult: results,
    },
  } }, { fromMe: true, ...overrides });
}

for (const scenario of [
  { name: 'empty result list', results: [], expected: 'empty_results' },
  { name: 'result without bytes', results: [{ mediaUploadResult: 2 }], expected: 'no_media_bytes' },
  { name: 'malformed protobuf', results: [{ placeholderMessageResendResponse: { webMessageInfoBytes: Uint8Array.of(255) } }], expected: 'decode_failed' },
]) {
  test(`reports ${scenario.name} rather than claiming phone silence`, async t => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const sock = socket();
    registerMessageHandlers(sock);
    const pending = recoverViewOnce(sock, message(null));
    await new Promise(resolve => setImmediate(resolve));
    await sock.emit('messages.upsert', { messages: [phoneReply(scenario.results)], type: 'notify' });
    t.mock.timers.tick(15000);
    const result = await pending;
    assert.equal(result.ok, false);
    assert.match(result.reason, new RegExp(scenario.expected));
    assert.doesNotMatch(result.reason, /No matching phone reply/);
  });
}

test('logs returned media under a different chat without dumping media credentials', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const sock = socket();
  registerMessageHandlers(sock);
  const original = message(null);
  const data = await fixture();
  const encoded = proto.WebMessageInfo.encode({ key: { ...original.key, remoteJid: 'alternate@lid' }, message: data.content }).finish();
  const pending = recoverViewOnce(sock, original);
  await new Promise(resolve => setImmediate(resolve));
  await sock.emit('messages.upsert', { messages: [phoneReply([{ placeholderMessageResendResponse: { webMessageInfoBytes: encoded } }])], type: 'notify' });
  t.mock.timers.tick(15000);
  assert.match((await pending).reason, /downloadable_payload/);
  const diagnostics = fs.readFileSync(path.join(temp, 'view-once.jsonl'), 'utf8');
  const detail = diagnostics.trim().split('\n').map(line => JSON.parse(line)).findLast(entry => entry.event === 'phone_result');
  assert.equal(detail.matchesMessageId, true);
  assert.equal(detail.matchesChat, false);
  assert.equal(detail.downloadable, true);
  assert.equal(diagnostics.includes(data.media.url), false);
  assert.equal(diagnostics.includes(data.media.mediaKey.toString('base64')), false);
});

test('foreign response cannot count as a matching phone reply', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const sock = socket();
  registerMessageHandlers(sock);
  const pending = recoverViewOnce(sock, message(null));
  await new Promise(resolve => setImmediate(resolve));
  await sock.emit('messages.upsert', { messages: [phoneReply([], { fromMe: false })], type: 'notify' });
  t.mock.timers.tick(15000);
  assert.match((await pending).reason, /No matching phone reply/);
});

test('request error acknowledgement reports the error instead of timing out', async () => {
  const sock = socket();
  registerMessageHandlers(sock);
  const pending = recoverViewOnce(sock, message(null));
  await new Promise(resolve => setImmediate(resolve));
  await sock.emit('messages.update', [{ key: { id: 'fixture-request' }, update: {
    status: proto.WebMessageInfo.Status.ERROR, messageStubParameters: ['479'],
  } }]);
  const result = await pending;
  assert.equal(result.event, 'request_rejected');
  assert.match(result.reason, /479/);
});

test('isolated vvtest alias retrieves media and retains the owner-only check', async () => {
  const sock = socket();
  const data = await fixture();
  const original = message(data.content);
  await handleViewOnce(sock, original);
  await handleCommand(sock, command(original), '.vvtest');
  assert.deepEqual(sock.sent.find(s => s.payload.image)?.payload.image, data.plaintext);
  const foreign = socket();
  await handleCommand(foreign, command(original, false), '.vvtest');
  assert.equal(foreign.sent.length, 0);
  assert.equal(foreign.requests.length, 0);
});

test('request rejection is not reported as success', async () => {
  const sock = socket();
  sock.requestPlaceholderResend = async () => { throw new Error('fixture disconnected'); };
  const result = await recoverViewOnce(sock, message(null));
  assert.equal(result.ok, false);
  assert.match(result.reason, /fixture disconnected/);
});

test('missing media keys and failed media downloads are not successes', async () => {
  assert.equal((await downloadViewOnceForVV(socket(), message({ imageMessage: { viewOnce: true } }))).ok, false);
  const data = await fixture();
  data.media.url = `http://127.0.0.1:${server.address().port}/missing`;
  assert.equal((await downloadViewOnceForVV(socket(), message(data.content))).ok, false);
});

test('send failure is reported after a successful download', async () => {
  const sock = socket();
  const data = await fixture();
  const original = message(data.content);
  await handleViewOnce(sock, original);
  const send = sock.sendMessage.bind(sock);
  sock.sendMessage = async (jid, payload) => {
    if (payload.image) throw new Error('fixture send failure');
    return send(jid, payload);
  };
  await handleCommand(sock, command(original), '.vv');
  assert.match(sock.sent.at(-1).payload.text, /sending to your inbox failed/);
  assert.ok(sock.sent.every(s => s.jid === '1111111111@s.whatsapp.net'));
  assert.equal(sock.sent.some(s => s.payload.react), false);
});

for (const emojiCommand of ['.👍', '.👎', '.💚', '.❤️', '.😊', '.❤']) {
  test(`${emojiCommand} silently retrieves then reacts to the original, for the owner only`, async () => {
    const sock = socket();
    registerMessageHandlers(sock);
    const data = await fixture();
    const original = message(data.content);
    await handleViewOnce(sock, original);
    const cmd = command(original);
    cmd.message.extendedTextMessage.text = emojiCommand;
    await sock.emit('messages.upsert', { messages: [cmd], type: 'notify' });
    assert.equal(sock.sent.length, 2);
    assert.equal(sock.sent[0].jid, '1111111111@s.whatsapp.net');
    assert.deepEqual(sock.sent[0].payload.image, data.plaintext);
    assert.deepEqual(sock.sent[1], { jid: chat, payload: { react: {
      text: '💚', key: { remoteJid: chat, id: original.key.id, fromMe: false },
    } } });
    assert.equal(sock.sent.some(s => s.payload.text), false);
    const foreign = socket();
    await handleCommand(foreign, command(original, false), emojiCommand);
    assert.equal(foreign.sent.length, 0);
    assert.equal(foreign.requests.length, 0);
  });
}

test('does not react until the media send finishes', async () => {
  const sock = socket();
  const data = await fixture();
  const original = message(data.content);
  await handleViewOnce(sock, original);
  let mediaStarted;
  let completeSend;
  const started = new Promise(resolve => { mediaStarted = resolve; });
  const completed = new Promise(resolve => { completeSend = resolve; });
  const send = sock.sendMessage.bind(sock);
  sock.sendMessage = async (jid, payload) => {
    if (payload.image) {
      mediaStarted();
      await completed;
    }
    return send(jid, payload);
  };
  const handling = handleCommand(sock, command(original), '.👍');
  await started;
  assert.equal(sock.sent.length, 0);
  completeSend();
  await handling;
  assert.ok(sock.sent[0].payload.image);
  assert.equal(sock.sent[1].payload.react.text, '💚');
});

test('missing sent-message ID never triggers a success reaction', async () => {
  const sock = socket();
  const data = await fixture();
  const original = message(data.content);
  await handleViewOnce(sock, original);
  const send = sock.sendMessage.bind(sock);
  sock.sendMessage = async (jid, payload) => payload.image ? undefined : send(jid, payload);
  await handleCommand(sock, command(original), '.💚');
  assert.equal(sock.sent.length, 1);
  assert.equal(sock.sent[0].jid, '1111111111@s.whatsapp.net');
  assert.match(sock.sent[0].payload.text, /No sent-message ID/);
});

test('download failures are private and never trigger a reaction', async () => {
  const sock = socket();
  const data = await fixture();
  data.media.url = `http://127.0.0.1:${server.address().port}/download-failure`;
  const original = message(data.content);
  await handleViewOnce(sock, original);
  await handleCommand(sock, command(original), '.👎');
  assert.equal(sock.sent.length, 1);
  assert.equal(sock.sent[0].jid, '1111111111@s.whatsapp.net');
  assert.match(sock.sent[0].payload.text, /Could not retrieve media/);
});

test('resend timeouts produce no waiting text and report the failure privately', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const sock = socket();
  const handling = handleCommand(sock, command(message(null)), '.😊');
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(sock.requests.length, 1);
  assert.equal(sock.sent.length, 0);
  t.mock.timers.tick(15000);
  await handling;
  assert.equal(sock.sent.length, 1);
  assert.equal(sock.sent[0].jid, '1111111111@s.whatsapp.net');
  assert.match(sock.sent[0].payload.text, /No downloadable media/);
});

test('reaction failures do not misreport a successful media send', async () => {
  const sock = socket();
  const data = await fixture();
  const original = message(data.content);
  await handleViewOnce(sock, original);
  const send = sock.sendMessage.bind(sock);
  sock.sendMessage = async (jid, payload) => {
    if (payload.react) throw new Error('fixture reaction failure');
    return send(jid, payload);
  };
  await handleCommand(sock, command(original), '.❤️');
  assert.equal(sock.sent.length, 2);
  assert.deepEqual(sock.sent[0].payload.image, data.plaintext);
  assert.match(sock.sent[1].payload.text, /media was sent.*confirmation reaction failed/);
  assert.ok(sock.sent.every(s => s.jid === '1111111111@s.whatsapp.net'));
});

test('reaction preserves the original group sender rather than the command sender', async () => {
  const sock = socket();
  const data = await fixture();
  const original = message(data.content, { remoteJid: 'test@g.us', participant: '2222222222@lid' });
  await handleViewOnce(sock, original);
  await handleCommand(sock, command(original), '.💚');
  assert.deepEqual(sock.sent[1].payload.react.key, {
    remoteJid: 'test@g.us', id: original.key.id, fromMe: false, participant: '2222222222@lid',
  });
  assert.equal(sock.sent[1].jid, 'test@g.us');
});

test('plain emojis and unlisted emoji commands do not trigger retrieval', async () => {
  const sock = socket();
  registerMessageHandlers(sock);
  for (const text of ['👍', '.🔥', '.👍👍', '.👍 please']) {
    const cmd = command(message(null));
    cmd.message.extendedTextMessage.text = text;
    await sock.emit('messages.upsert', { messages: [cmd], type: 'notify' });
  }
  assert.equal(sock.requests.length, 0);
  assert.equal(sock.sent.length, 0);
});

test('status broadcasts remain ignored and normal reactions still work', async () => {
  const sock = socket();
  registerMessageHandlers(sock);
  const status = message(null, { remoteJid: 'status@broadcast', isViewOnce: true });
  await sock.emit('messages.upsert', { messages: [status], type: 'notify' });
  assert.equal(getStoredViewOnce(status.key.remoteJid, status.key.id), null);
  const count = reactionStats.count;
  await sock.emit('messages.upsert', { messages: [message({ reactionMessage: { text: '+1', key: { id: 'target' } } })], type: 'notify' });
  assert.equal(reactionStats.count, count + 1);
});
