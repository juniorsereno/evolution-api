const assert = require('node:assert/strict');
const { before, after, test } = require('node:test');
const http = require('node:http');
const { Readable } = require('node:stream');
const { PrismaClient } = require('@prisma/client');
const { ChatwootService } = require('../dist/api/integrations/chatbot/chatwoot/services/chatwoot.service');
const EventEmitter2 = require('eventemitter2');
const { BaileysStartupService } = require('../dist/api/integrations/channel/whatsapp/whatsapp.baileys.service');
const { configService } = require('../dist/config/env.config');
if (new URL(process.env.DATABASE_CONNECTION_URI).pathname !== '/evolution_runtime_test') throw Error('Disposable database required');
const prisma = new PrismaClient();
const requests = [];
let server, subject, instance;
const senders = [];
before(async () => {
  instance = await prisma.instance.create({ data: { name: 'synthetic-external-' + Date.now() } });
  server = http.createServer(async (req, res) => {
    let raw = ''; for await (const chunk of req) raw += chunk;
    const payload = req.headers['content-type']?.startsWith('multipart/form-data')
      ? Object.fromEntries([...raw.matchAll(/name="([^"]+)"\r\n\r\n([\s\S]*?)\r\n--/g)].map(match => [match[1], match[2]]))
      : raw ? JSON.parse(raw) : {};
    if (typeof payload.content_attributes === 'string') payload.content_attributes = JSON.parse(payload.content_attributes);
    payload.hasFile = raw.includes('filename="synthetic.txt"');
    requests.push(payload);
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ id: requests.length, inbox_id: 30, conversation_id: 42 }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const monitor = { waInstances: {} };
  subject = new ChatwootService(monitor, configService, prisma, { has: async () => false, get: async () => null, set() {} });
  subject.provider = { enabled: true, accountId: '6', token: 'synthetic-only', url: 'http://127.0.0.1:' + server.address().port };
  monitor.waInstances[instance.name] = { findChatwoot: async () => subject.provider };
  subject.isImportHistoryAvailable = () => false;
});
after(async () => {
  for (const sender of senders) sender.messageProcessor.onDestroy();
  server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
  await prisma.instance.delete({ where: { id: instance.id } });
  await prisma.$disconnect(); await subject.pgClient.end();
});
for (const fromMe of [false, true]) {
  test('SDK payload identifies external WhatsApp origin only for outgoing messages, fromMe=' + fromMe, async () => {
    const message = { key: { id: 'synthetic-external-' + fromMe, remoteJid: '5511900000000@s.whatsapp.net', fromMe } };
    await subject.createMessage({ instanceName: instance.name, instanceId: instance.id }, 42, 'Synthetic', fromMe ? 'outgoing' : 'incoming', false, [], message, 'WAID:' + message.key.id);
    const payload = requests.at(-1);
    assert.equal(payload.content_attributes.external_echo, fromMe ? true : undefined);
    assert.equal(payload.content_attributes.external_source, fromMe ? 'whatsapp' : undefined);
  });
}

function sender() {
  const cache = { get: async () => null, has: async () => false, set() {}, delete() {} };
  const service = new BaileysStartupService(configService, new EventEmitter2(), prisma, cache, cache, cache, null);
  Object.assign(service.instance, { id: instance.id, name: instance.name });
  service.sendDataWebhook = async () => {};
  service.client = {
    user: { id: '5511900000000@s.whatsapp.net' },
    onWhatsApp: async (...jids) => jids.map(jid => ({ jid, exists: true })),
    sendMessage: async (jid, content, options) => ({ key: { id: options.messageId, remoteJid: jid, fromMe: true }, message: { conversation: content.text }, messageTimestamp: 1700000000 }),
  };
  senders.push(service); return service;
}

test('persists the original Vartana author link before sending and reuses it after a service restart', async () => {
  const service = sender();
  const send = service.client.sendMessage;
  const context = { kind: 'chatwoot', accountId: '6', messageId: 9001, inboxId: 30, conversationId: 42 };
  let enteredWire = false;
  service.client.sendMessage = async (jid, content, options) => {
    const origin = await prisma.messageOrigin.findUnique({ where: { instanceId_messageId: { instanceId: instance.id, messageId: options.messageId } } });
    assert.equal(origin.origin, 'chatwoot');
    assert.equal(origin.chatwootMessageId, 9001);
    enteredWire = true;
    return send(jid, content, options);
  };
  const result = await service.textMessage({ number: '5511900000000', text: 'Synthetic agent message' }, true, context);
  assert.equal(enteredWire, true);
  const initialCount = requests.length;
  const restored = new ChatwootService({ waInstances: { [instance.name]: { findChatwoot: async () => subject.provider } } }, configService, prisma,
    { has: async () => false, get: async () => null, set() {} });
  // Runtime event processing needs the configured instance, but must not create any new Vartana message.
  restored.waMonitor.waInstances[instance.name] = { instanceId: instance.id, findChatwoot: async () => subject.provider };
  const echo = await restored.eventWhatsapp('messages.upsert', { instanceName: instance.name, instanceId: instance.id }, result);
  assert.deepEqual(echo, { id: 9001, inbox_id: 30, conversation_id: 42 });
  assert.equal(requests.length, initialCount);
});

test('a standalone API send is not misclassified as a message from the WhatsApp app', async () => {
  const service = sender();
  const result = await service.textMessage({ number: '5511900000000', text: 'Synthetic integration' }, true);
  await subject.createMessage({ instanceName: instance.name, instanceId: instance.id }, 42, 'Synthetic integration', 'outgoing', false, [], result, 'WAID:' + result.key.id);
  assert.equal(requests.at(-1).content_attributes.external_source, 'evolution_api');
  assert.equal(requests.at(-1).content_attributes.external_echo, undefined);
});

test('refuses to send when the persistent origin cannot be recorded', async () => {
  const service = sender();
  let sent = false;
  service.client.sendMessage = async () => { sent = true; throw Error('Must not reach the wire'); };
  await assert.rejects(service.textMessage({ number: '5511900000000', text: 'Synthetic' }, true,
    { kind: 'chatwoot', accountId: '6', messageId: null, inboxId: 30, conversationId: 42 }));
  assert.equal(sent, false);
});

test('multipart media retains native-app origin and the quoted-message link', async () => {
  await prisma.message.create({ data: { instanceId: instance.id, key: { id: 'synthetic-media-quote', fromMe: false, remoteJid: '5511900000000@s.whatsapp.net' },
    messageType: 'conversation', message: { conversation: 'Synthetic original' }, messageTimestamp: 1700000000, source: 'web', chatwootMessageId: 7000 } });
  const data = { key: { id: 'synthetic-media', fromMe: true }, contextInfo: { stanzaId: 'synthetic-media-quote' } };
  await subject.sendData(42, Readable.from(Buffer.from('Synthetic file')), 'synthetic.txt', 'outgoing', 'Synthetic file',
    { instanceName: instance.name, instanceId: instance.id }, data, 'WAID:synthetic-media');
  const payload = requests.at(-1);
  assert.equal(payload.hasFile, true);
  assert.equal(payload.content_attributes.external_echo, true);
  assert.equal(payload.content_attributes.external_source, 'whatsapp');
  assert.equal(payload.content_attributes.in_reply_to, 7000);
});

test('a received external message never loops back into the WhatsApp send path', async () => {
  const count = requests.length;
  assert.deepEqual(await subject.receiveWebhook({ instanceName: instance.name, instanceId: instance.id }, {
    conversation: {}, event: 'message_created', message_type: 'outgoing',
    content_attributes: { external_echo: true, external_source: 'whatsapp' },
  }), { message: 'bot' });
  assert.equal(requests.length, count);
});

test('large history origin lookups reach the final batch without exceeding database parameter limits', async () => {
  await prisma.messageOrigin.create({ data: { instanceId: instance.id, messageId: 'synthetic-batch-last', origin: 'api' } });
  const ids = Array.from({ length: 70000 }, (_, i) => 'synthetic-missing-' + i).concat('synthetic-batch-last');
  const origins = await subject.getMessageOrigins({ instanceName: instance.name, instanceId: instance.id }, ids);
  assert.deepEqual(origins.map(row => row.messageId), ['synthetic-batch-last']);
});

test('a native WhatsApp reaction keeps external origin through reaction formatting', async () => {
  subject.createConversation = async () => 42;
  const phone = '5511900000000@s.whatsapp.net';
  const before = requests.length;
  await subject.eventWhatsapp('messages.upsert', { instanceName: instance.name, instanceId: instance.id }, {
    key: { id: 'synthetic-native-reaction', fromMe: true, remoteJid: phone }, messageType: 'reactionMessage',
    message: { reactionMessage: { text: '👍', key: { id: 'synthetic-media-quote', fromMe: false, remoteJid: phone } } },
    messageTimestamp: 1700000000,
  });
  assert.equal(requests.length, before + 1);
  assert.equal(requests.at(-1).content_attributes.external_echo, true);
  assert.equal(requests.at(-1).content_attributes.external_source, 'whatsapp');
});
