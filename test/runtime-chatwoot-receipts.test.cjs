const assert = require('node:assert/strict');
const { before, after, beforeEach, test } = require('node:test');
const http = require('node:http');
const { setTimeout: delay } = require('node:timers/promises');
async function waitForRequests(count) {
  const deadline = Date.now() + 3000;
  while (requests.length < count && Date.now() < deadline) await delay(10);
  assert.equal(requests.length, count);
  await delay(30);
}
const { PrismaClient } = require('@prisma/client');
const EventEmitter2 = require('eventemitter2');
if (new URL(process.env.DATABASE_CONNECTION_URI).pathname !== '/evolution_runtime_test') throw Error('Disposable database required');
const { ChatwootService } = require('../dist/api/integrations/chatbot/chatwoot/services/chatwoot.service');
const { BaileysStartupService } = require('../dist/api/integrations/channel/whatsapp/whatsapp.baileys.service');
const { MessageReceiptService } = require('../dist/api/integrations/channel/whatsapp/message-receipt.service');
const { configService } = require('../dist/config/env.config');
const prisma = new PrismaClient();
const receipts = new MessageReceiptService(prisma, false, async () => null);
const group = '120363000000011@g.us', phone = '12025550102@s.whatsapp.net';
let first, second, service, server, providers, requests, failHttp, holdHttp, heldResponses;
const receivers = [];
before(async () => {
  first = await prisma.instance.create({ data: { name: 'synthetic-chatwoot-receipts-a' } });
  second = await prisma.instance.create({ data: { name: 'synthetic-chatwoot-receipts-b' } });
  server = http.createServer(async (req, res) => {
    let body = ''; for await (const chunk of req) body += chunk;
    requests.push({ method: req.method, url: req.url, body: body ? JSON.parse(body) : null, token: req.headers.api_access_token });
    if (holdHttp) { heldResponses.push(res); return; }
    res.writeHead(failHttp ? 503 : 200, { 'Content-Type': 'application/json' }); res.end('{}');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  providers = new Map([
    [first.name, { enabled: true, accountId: '6', token: 'synthetic-a', url: 'http://127.0.0.1:' + server.address().port }],
    [second.name, { enabled: true, accountId: '7', token: 'synthetic-b', url: 'http://127.0.0.1:' + server.address().port }],
  ]);
  const waInstances = Object.fromEntries([...providers].map(([name, provider]) => [name, { findChatwoot: async () => provider }]));
  service = new ChatwootService({ waInstances }, configService, prisma, { has: async () => false, set() {} });
});
beforeEach(async () => {
  requests = []; failHttp = false; holdHttp = false; heldResponses = [];
  await prisma.message.deleteMany({ where: { instanceId: { in: [first.id, second.id] } } });
  await prisma.messageOrigin.deleteMany({ where: { instanceId: { in: [first.id, second.id] } } });
});
after(async () => {
  for (const r of receivers) {
    r.messageProcessor.onDestroy(); await r.credentialPersistence?.stop();
    r.userDevicesCache.close(); r.msgRetryCounterCache.close();
  }
  server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
  await service.pgClient.end();
  await prisma.instance.deleteMany({ where: { id: { in: [first.id, second.id] } } });
  await prisma.$disconnect();
});
const scope = instance => ({ instanceName: instance.name, instanceId: instance.id });
async function message(id, { instance = first, remoteJid = phone, cw = 9001, snapshot, parts, status = 'PENDING' } = {}) {
  const account = providers.get(instance.name).accountId;
  const saved = await prisma.message.create({ data: { instanceId: instance.id, key: { id, remoteJid, fromMe: true }, message: { conversation: 'Synthetic' }, messageType: 'conversation', source: 'web', messageTimestamp: 1700000000, status, chatwootMessageParts: parts, chatwootMessageId: cw, chatwootInboxId: 30, chatwootConversationId: 42, ...(snapshot ? { groupReceiptRecipients: snapshot } : {}) } });
  await prisma.messageOrigin.create({ data: { instanceId: instance.id, messageId: id, origin: 'chatwoot', chatwootAccountId: account, chatwootMessageId: cw, chatwootInboxId: 30, chatwootConversationId: 42 } });
  return saved;
}
async function record(saved, status, participant) {
  await receipts.record(saved.instanceId, saved.key, status, true, participant);
  return service.syncMessageReceiptStatus(scope(saved.instanceId === first.id ? first : second), saved.id);
}

test('individual delivery and read update only the mapped message, never conversation last-seen', async () => {
  const saved = await message('direct-status');
  await record(saved, 'SERVER_ACK'); assert.equal(requests.length, 0);
  await record(saved, 'DELIVERY_ACK'); await record(saved, 'READ');
  assert.deepEqual(requests.map(r => [r.method, r.url, r.body]), [
    ['PATCH', '/api/v1/accounts/6/conversations/42/messages/9001', { status: 'delivered' }],
    ['PATCH', '/api/v1/accounts/6/conversations/42/messages/9001', { status: 'read' }],
  ]);
});

test('group global status waits for all original recipients despite a member reading early', async () => {
  const saved = await message('group-global', { remoteJid: group, snapshot: [['100000000002@lid'], ['100000000003@lid']] });
  await record(saved, 'READ', '100000000002@lid'); assert.equal(requests.length, 0);
  await record(saved, 'DELIVERY_ACK', '100000000003@lid');
  await record(saved, 'READ', '100000000003@lid');
  assert.deepEqual(requests.map(r => r.body.status), ['delivered', 'read']);
});

test('multipart delivery cannot mark a Vartana message read while another attachment is pending', async () => {
  const one = await message('part-one', { status: 'READ' });
  const two = await message('part-two');
  await service.syncMessageReceiptStatus(scope(first), one.id); assert.equal(requests.length, 0);
  await record(two, 'DELIVERY_ACK'); await record(two, 'READ');
  assert.deepEqual(requests.map(r => r.body.status), ['delivered', 'read']);
});

test('concurrent instances keep their own account, token and message destination', async () => {
  const one = await message('same-wa-id', { status: 'READ' });
  const two = await message('same-wa-id', { instance: second, cw: 9002, status: 'DELIVERY_ACK' });
  await Promise.all([service.syncMessageReceiptStatus(scope(first), one.id), service.syncMessageReceiptStatus(scope(second), two.id)]);
  assert.deepEqual(requests.map(r => [r.url, r.token, r.body.status]).sort(), [
    ['/api/v1/accounts/6/conversations/42/messages/9001', 'synthetic-a', 'read'],
    ['/api/v1/accounts/7/conversations/42/messages/9002', 'synthetic-b', 'delivered'],
  ]);
});

test('foreign instance IDs and inconsistent account mappings send no status requests', async () => {
  const saved = await message('wrong-account', { status: 'READ' });
  assert.equal(await service.syncMessageReceiptStatus(scope(second), saved.id), null);
  await prisma.messageOrigin.update({ where: { instanceId_messageId: { instanceId: first.id, messageId: 'wrong-account' } }, data: { chatwootAccountId: '7' } });
  await assert.rejects(service.syncMessageReceiptStatus(scope(first), saved.id), /configured Chatwoot destination/);
  assert.equal(requests.length, 0);
});

test('a duplicate receipt can retry a failed status PATCH without sending another WhatsApp message', async () => {
  const saved = await message('http-retry', { remoteJid: group, snapshot: [['100000000002@lid']] });
  const subject = new BaileysStartupService(configService, new EventEmitter2(), prisma, {}, {}, {}, null);
  Object.assign(subject.instance, { id: first.id, name: first.name, authState: { saveCreds: async () => {} } });
  subject.findSettings = async () => ({ groupsIgnore: false }); subject.sendDataWebhook = async () => {};
  subject.localChatwoot.enabled = true; subject.chatwootService = service;
  let dispatch;
  subject.client = { user: { id: '12025550101@s.whatsapp.net' }, ev: { process: callback => { dispatch = callback; } } };
  subject.eventHandler(); receivers.push(subject);
  const event = { 'message-receipt.update': [{ key: saved.key, receipt: { userJid: '100000000002@lid', readTimestamp: 1700000010 } }] };
  failHttp = true; await dispatch(event); await subject.eventProcessingQueue; await waitForRequests(1);
  assert.equal((await prisma.message.findUnique({ where: { id: saved.id } })).status, 'READ');
  failHttp = false; await dispatch(event); await subject.eventProcessingQueue; await waitForRequests(2);
  assert.equal(await prisma.messageUpdate.count({ where: { messageId: saved.id } }), 1);
  assert.deepEqual(requests.map(r => r.body.status), ['read', 'read']);
});

 test('an early receipt cannot complete a multipart message before the remaining parts exist', async () => {
  const one = await message('early-part', { status: 'READ', parts: 2 });
  await service.syncMessageReceiptStatus(scope(first), one.id); assert.equal(requests.length, 0);
  const two = await message('later-part', { parts: 2 });
  await service.syncMessageReceiptStatus(scope(first), one.id); assert.equal(requests.length, 0);
  await record(two, 'DELIVERY_ACK'); await record(two, 'READ');
  assert.deepEqual(requests.map(r => r.body.status), ['delivered', 'read']);
});

test('a slow Vartana status response does not block processing subsequent WhatsApp events', async () => {
  const saved = await message('slow-http', { remoteJid: group, snapshot: [['100000000002@lid']] });
  const subject = new BaileysStartupService(configService, new EventEmitter2(), prisma, {}, {}, {}, null);
  Object.assign(subject.instance, { id: first.id, name: first.name, authState: { saveCreds: async () => {} } });
  subject.findSettings = async () => ({ groupsIgnore: false }); subject.sendDataWebhook = async () => {};
  subject.localChatwoot.enabled = true; subject.chatwootService = service;
  let dispatch;
  subject.client = { user: { id: '12025550101@s.whatsapp.net' }, ev: { process: callback => { dispatch = callback; } } };
  subject.eventHandler(); receivers.push(subject);
  holdHttp = true;
  try {
    await dispatch({ 'message-receipt.update': [{ key: saved.key, receipt: { userJid: '100000000002@lid', readTimestamp: 1700000010 } }] });
    await Promise.race([subject.eventProcessingQueue, delay(1000).then(() => { throw Error('WhatsApp event queue blocked by status HTTP'); })]);
    await waitForRequests(1);
    assert.equal(heldResponses.length, 1);
    assert.equal((await prisma.message.findUnique({ where: { id: saved.id } })).status, 'READ');
  } finally {
    for (const res of heldResponses) { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end('{}'); }
    await delay(30);
  }
});

test('the Vartana webhook passes the complete attachment count to every WhatsApp send', async () => {
  const monitor = { waInstances: { [first.name]: { instanceId: first.id, findChatwoot: async () => providers.get(first.name) } } };
  const webhook = new ChatwootService(monitor, configService, prisma, { has: async () => false, set() {} });
  const origins = [];
  webhook.getQuotedMessage = async () => undefined;
  webhook.sendAttachment = async (_wa, _chat, _media, _caption, _options, origin) => { origins.push(origin); return { key: { id: 'synthetic-part-' + origins.length } }; };
  webhook.updateChatwootMessageId = async () => {};
  const result = await webhook.receiveWebhook(scope(first), {
    id: 9001, event: 'message_created', message_type: 'outgoing', content: 'Synthetic', inbox: { id: 30 },
    conversation: { id: 42, meta: { sender: { identifier: group } }, messages: [{ attachments: [{ data_url: 'https://example.invalid/a.pdf' }, { data_url: 'https://example.invalid/b.pdf' }] }] },
  });
  assert.equal(origins.length, 2);
  assert.deepEqual(origins.map(origin => origin.expectedParts), [2, 2]);
  assert.notEqual(result, null);
});

test('verified PN/LID receipts update the mapped Vartana message without resending WhatsApp content', async () => {
  const saved = await message('direct-lid-http');
  const subject = new BaileysStartupService(configService, new EventEmitter2(), prisma, {}, {}, {}, null);
  Object.assign(subject.instance, { id: first.id, name: first.name, authState: { saveCreds: async () => {} } });
  subject.findSettings = async () => ({ groupsIgnore: false }); subject.sendDataWebhook = async () => {};
  subject.localChatwoot.enabled = true; subject.chatwootService = service;
  let dispatch;
  subject.client = { user: { id: '12025550101@s.whatsapp.net' }, signalRepository: { lidMapping: { getPNForLID: async lid => lid === '100000000002@lid' ? phone : null } }, ev: { process: callback => { dispatch = callback; } } };
  subject.eventHandler(); receivers.push(subject);
  await dispatch({ 'messages.update': [{ key: { id: saved.key.id, remoteJid: '100000000002@lid' }, update: { status: 3 } }] }); await subject.eventProcessingQueue; await waitForRequests(1);
  await dispatch({ 'messages.update': [{ key: { id: saved.key.id, remoteJid: '100000000002:5@hosted.lid' }, update: { status: 4 } }] }); await subject.eventProcessingQueue; await waitForRequests(2);
  assert.deepEqual(requests.map(r => [r.method, r.url, r.body.status]), [
    ['PATCH', '/api/v1/accounts/6/conversations/42/messages/9001', 'delivered'],
    ['PATCH', '/api/v1/accounts/6/conversations/42/messages/9001', 'read'],
  ]);
  assert.equal((await prisma.message.findUnique({ where: { id: saved.id } })).status, 'READ');
});
