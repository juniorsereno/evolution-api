const assert = require('node:assert/strict');
const { before, after, beforeEach, test } = require('node:test');
const { PrismaClient } = require('@prisma/client');
const EventEmitter2 = require('eventemitter2');
if (new URL(process.env.DATABASE_CONNECTION_URI).pathname !== '/evolution_runtime_test') {
  throw Error('Disposable runtime database required');
}
const { BaileysStartupService } = require((process.env.EVOLUTION_TEST_DIST || '../dist') + '/api/integrations/channel/whatsapp/whatsapp.baileys.service');
const { configService } = require('../dist/config/env.config');
const prisma = new PrismaClient();
const group = '120363000000001@g.us', phone = '12025550102@s.whatsapp.net';
const subjects = [];
let instance;
const cache = () => {
  const values = new Map();
  return { get: async key => values.get(key), has: async key => values.has(key), set: async (key, value) => values.set(key, value), delete: async key => values.delete(key) };
};
before(async () => { instance = await prisma.instance.create({ data: { name: 'synthetic-receipt-status' } }); });
beforeEach(async () => { await prisma.message.deleteMany({ where: { instanceId: instance.id } }); });
after(async () => {
  for (const subject of subjects) {
    subject.messageProcessor.onDestroy();
    await subject.credentialPersistence?.stop();
    subject.userDevicesCache.close();
    subject.msgRetryCounterCache.close();
  }
  await subjects[0]?.chatwootService.pgClient.end();
  await prisma.instance.delete({ where: { id: instance.id } });
  await prisma.$disconnect();
});
function receiver() {
  const subject = new BaileysStartupService(configService, new EventEmitter2(), prisma, cache(), cache(), cache(), null);
  Object.assign(subject.instance, { id: instance.id, name: instance.name, authState: { saveCreds: async () => {} } });
  subject.findSettings = async () => ({ groupsIgnore: false });
  subject.sendDataWebhook = async () => {};
  let dispatch;
  subject.client = { user: { id: '12025550101:1@s.whatsapp.net', lid: '100000000001:1@lid' }, ev: { process: callback => { dispatch = callback; } } };
  subject.eventHandler();
  subjects.push(subject);
  return { subject, dispatch: async events => { await dispatch(events); await subject.eventProcessingQueue; } };
}
function message(id, remoteJid = group, fromMe = true, extra = {}) {
  return prisma.message.create({ data: { instanceId: instance.id, key: { id, remoteJid, fromMe }, message: { conversation: 'Synthetic' }, messageType: 'conversation', source: 'web', messageTimestamp: 1700000000, status: 'PENDING', ...extra } });
}
function receipt(id, userJid, field = 'receiptTimestamp', remoteJid = group) {
  return { key: { id, remoteJid, fromMe: true }, receipt: { userJid, [field]: 1700000010 } };
}

test('group receipt reaches durable participant history without claiming every member read it', async () => {
  const saved = await message('group-delivery');
  const { dispatch } = receiver();
  await dispatch({ 'message-receipt.update': [receipt('group-delivery', '100000000002@lid')] });
  const updates = await prisma.messageUpdate.findMany({ where: { messageId: saved.id } });
  assert.deepEqual(updates.map(row => ({ status: row.status, participant: row.participant, remoteJid: row.remoteJid })), [
    { status: 'DELIVERY_ACK', participant: '100000000002@lid', remoteJid: group },
  ]);
  assert.equal((await prisma.message.findUnique({ where: { id: saved.id } })).status, 'SERVER_ACK');
});

test('a status update with only its WhatsApp ID recovers the stored address and direction', async () => {
  const saved = await message('partial-key', phone);
  const { dispatch } = receiver();
  await dispatch({ 'messages.update': [{ key: { id: 'partial-key', fromMe: true }, update: { status: 2 } }] });
  const updates = await prisma.messageUpdate.findMany({ where: { messageId: saved.id } });
  assert.deepEqual(updates.map(row => ({ status: row.status, remoteJid: row.remoteJid, fromMe: row.fromMe })), [
    { status: 'SERVER_ACK', remoteJid: phone, fromMe: true },
  ]);
  assert.equal((await prisma.message.findUnique({ where: { id: saved.id } })).status, 'SERVER_ACK');
});

test('a group member reading an outgoing message does not mark incoming chat messages as read', async () => {
  await message('outgoing-read');
  const incoming = await message('incoming-unseen', group, false);
  const { dispatch } = receiver();
  await dispatch({ 'message-receipt.update': [receipt('outgoing-read', '100000000002@lid', 'readTimestamp')] });
  assert.equal((await prisma.message.findUnique({ where: { id: incoming.id } })).status, 'PENDING');
});

test('only all send-time recipients can advance the group-wide delivery and read status', async () => {
  const saved = await message('all-members', group, true, { groupReceiptRecipients: [[phone, '100000000002@lid'], ['12025550103@s.whatsapp.net', '100000000003@lid']] });
  const { dispatch } = receiver();
  const status = async () => (await prisma.message.findUnique({ where: { id: saved.id } })).status;
  await dispatch({ 'message-receipt.update': [receipt('all-members', '100000000002@lid', 'readTimestamp')] });
  assert.equal(await status(), 'SERVER_ACK');
  await dispatch({ 'message-receipt.update': [receipt('all-members', '12025550103@s.whatsapp.net')] });
  assert.equal(await status(), 'DELIVERY_ACK');
  await dispatch({ 'message-receipt.update': [receipt('all-members', '100000000003@lid', 'readTimestamp')] });
  assert.equal(await status(), 'READ');
  await dispatch({ 'message-receipt.update': [receipt('all-members', phone)] });
  await dispatch({ 'messages.update': [{ key: { id: 'all-members', fromMe: true }, update: { status: 2 } }] });
  assert.equal(await status(), 'READ');
});

test('concurrent participant receipts and duplicates converge without regressions or duplicate history', async () => {
  const { MessageReceiptService } = require('../dist/api/integrations/channel/whatsapp/message-receipt.service');
  const saved = await message('concurrent-members', group, true, { groupReceiptRecipients: [['100000000002@lid'], ['100000000003@lid']] });
  const service = new MessageReceiptService(prisma, false);
  const key = { id: 'concurrent-members', remoteJid: group, fromMe: true };
  await Promise.all(Array.from({ length: 6 }, (_, i) => service.record(instance.id, key, 'READ', true, i % 2 ? '100000000002@lid' : '100000000003@lid')));
  assert.equal(await prisma.messageUpdate.count({ where: { messageId: saved.id } }), 2);
  assert.equal((await prisma.message.findUnique({ where: { id: saved.id } })).status, 'READ');
});

test('receipts for another conversation or instance cannot change this message', async () => {
  const saved = await message('scoped-receipt');
  const { dispatch } = receiver();
  await dispatch({ 'message-receipt.update': [receipt('scoped-receipt', '100000000002@lid', 'readTimestamp', '120363000000002@g.us')] });
  const { MessageReceiptService } = require('../dist/api/integrations/channel/whatsapp/message-receipt.service');
  assert.equal(await new MessageReceiptService(prisma, false).record('another-instance', { id: 'scoped-receipt' }, 'READ', true), null);
  assert.equal(await prisma.messageUpdate.count({ where: { messageId: saved.id } }), 0);
  assert.equal((await prisma.message.findUnique({ where: { id: saved.id } })).status, 'PENDING');
});

test('the group snapshot keeps PN/LID aliases and excludes every sender identity', () => {
  const { captureGroupReceiptRecipients } = require('../dist/api/integrations/channel/whatsapp/message-receipt.service');
  assert.deepEqual(captureGroupReceiptRecipients([
    { id: '100000000001@lid', phoneNumber: '12025550101@s.whatsapp.net' },
    { id: '100000000002@lid', phoneNumber: phone },
    { id: phone, lid: '100000000002@lid' },
  ], { id: '12025550101:1@s.whatsapp.net', lid: '100000000001:1@lid' }), [['100000000002@lid', phone]]);
});

test('a non-recipient cannot satisfy another group member confirmation', async () => {
  const saved = await message('unknown-member', group, true, { groupReceiptRecipients: [['100000000002@lid']] });
  const { dispatch } = receiver();
  await dispatch({ 'message-receipt.update': [receipt('unknown-member', '100000000099@lid', 'readTimestamp')] });
  assert.equal((await prisma.message.findUnique({ where: { id: saved.id } })).status, 'SERVER_ACK');
});

test('invalid timestamps are not interpreted as delivery or read confirmations', async () => {
  const saved = await message('invalid-clock');
  const { dispatch } = receiver();
  await dispatch({ 'message-receipt.update': [
    { key: { id: 'invalid-clock', remoteJid: group, fromMe: true }, receipt: { userJid: '100000000002@lid', readTimestamp: NaN } },
    { key: { id: 'invalid-clock', remoteJid: group, fromMe: true }, receipt: { userJid: '100000000002@lid', receiptTimestamp: -1 } },
  ] });
  assert.equal(await prisma.messageUpdate.count({ where: { messageId: saved.id } }), 0);
});

 test('the send pipeline stores recipient aliases and expected attachment count before handling receipts', async () => {
  const { subject } = receiver();
  subject.whatsappNumber = async () => [{ exists: true, jid: group }];
  subject.getGroupMetadataCache = async () => ({ participants: [
    { id: '100000000001@lid', phoneNumber: '12025550101@s.whatsapp.net' },
    { id: '100000000002@lid', phoneNumber: phone },
  ] });
  subject.sendMessage = async () => ({ key: { id: 'send-snapshot', remoteJid: group, fromMe: true }, message: { conversation: 'Synthetic' }, messageTimestamp: 1700000000, status: 2 });
  await subject.textMessage({ number: group, text: 'Synthetic' }, true, { kind: 'chatwoot', accountId: '6', messageId: 9001, inboxId: 30, conversationId: 42, expectedParts: 2 });
  const saved = await prisma.message.findFirst({ where: { instanceId: instance.id, key: { path: ['id'], equals: 'send-snapshot' } } });
  assert.deepEqual(saved.groupReceiptRecipients, [['100000000002@lid', phone]]);
  assert.equal(saved.chatwootMessageParts, 2);
});
