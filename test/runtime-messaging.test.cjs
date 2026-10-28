const assert = require('node:assert/strict');
const { before, after, test } = require('node:test');
const { PrismaClient } = require('@prisma/client');
const EventEmitter2 = require('eventemitter2');
if (new URL(process.env.DATABASE_CONNECTION_URI).pathname !== '/evolution_runtime_test') {
  throw Error('Use the disposable evolution_runtime_test database.');
}
const { BaileysStartupService } = require('../dist/api/integrations/channel/whatsapp/whatsapp.baileys.service');
const { configService } = require('../dist/config/env.config');
const prisma = new PrismaClient();
const cache = { get: async () => null, has: async () => false, set: async () => {}, delete: async () => {} };
const phone = '5511900000042@s.whatsapp.net';
const services = [];
let instance, sequence = 0;
before(async () => { instance = await prisma.instance.create({ data: { name: 'synthetic-messaging-' + Date.now() } }); });
after(async () => {
  for (const subject of services) subject.messageProcessor.onDestroy();
  await prisma.instance.delete({ where: { id: instance.id } });
  await prisma.$disconnect();
});
function service() {
  const subject = new BaileysStartupService(configService, new EventEmitter2(), prisma, cache, cache, cache, null);
  Object.assign(subject.instance, { id: instance.id, name: instance.name });
  const sent = [];
  subject.client = {
    onWhatsApp: async (...jids) => jids.map(jid => ({ jid, exists: true })),
    sendMessage: async (jid, content, options) => {
      sent.push({ jid, content, options });
      return { key: { id: 'synthetic-audio-' + sequence++, remoteJid: jid, fromMe: true },
        message: { audioMessage: { mimetype: 'audio/ogg; codecs=opus', ptt: true } }, messageTimestamp: 1700000000 };
    },
  };
  subject.sendDataWebhook = async () => {};
  services.push(subject);
  return { subject, sent };
}
function silence() {
  const buffer = Buffer.alloc(44 + 16000);
  buffer.write('RIFF'); buffer.writeUInt32LE(buffer.length - 8, 4); buffer.write('WAVEfmt ', 8);
  buffer.writeUInt32LE(16, 16); buffer.writeUInt16LE(1, 20); buffer.writeUInt16LE(1, 22);
  buffer.writeUInt32LE(8000, 24); buffer.writeUInt32LE(16000, 28); buffer.writeUInt16LE(2, 32);
  buffer.writeUInt16LE(16, 34); buffer.write('data', 36); buffer.writeUInt32LE(16000, 40);
  return buffer.toString('base64');
}
for (const encoding of [false, true]) {
  test(`audio reply retains the quoted message through the SDK boundary, encoding=${encoding}`, async () => {
    const { subject, sent } = service();
    const quoted = { key: { id: 'synthetic-original', remoteJid: phone, fromMe: false }, message: { conversation: 'Original' } };
    await subject.audioWhatsapp({ number: phone, audio: silence(), encoding, quoted }, null, true);
    assert.equal(sent.length, 1);
    assert.equal(sent[0].jid, phone);
    assert.equal(sent[0].content.ptt, true);
    assert.deepEqual(sent[0].options.quoted, quoted);
  });
}

test('ordinary audio remains unquoted', async () => {
  const { subject, sent } = service();
  await subject.audioWhatsapp({ number: phone, audio: silence(), encoding: false }, null, true);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].options.quoted, undefined);
});

test('a direct LID remains an address and is sent without inventing a phone number', async () => {
  const { subject, sent } = service();
  const lid = '1234567890999999@lid';
  subject.client.onWhatsApp = async () => { throw Error('LIDs must not use phone-number verification'); };
  await subject.audioWhatsapp({ number: lid, audio: silence(), encoding: false }, null, true);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].jid, lid);
});

test('a phone number rejected by WhatsApp is still rejected before sending', async () => {
  const { subject, sent } = service();
  subject.client.onWhatsApp = async (...jids) => jids.map(jid => ({ jid, exists: false }));
  await assert.rejects(subject.audioWhatsapp({ number: '5511900000043', audio: silence(), encoding: false }, null, true));
  assert.equal(sent.length, 0);
});

test('last-message consumers use the latest message of the correct conversation and instance', async () => {
  const { subject } = service();
  const foreign = await prisma.instance.create({ data: { name: 'synthetic-foreign-' + Date.now() } });
  const record = (id, remoteJid, timestamp, instanceId = instance.id) => ({
    instanceId, key: { id, remoteJid, fromMe: false }, message: { conversation: id },
    messageType: 'conversation', messageTimestamp: timestamp, source: 'web',
  });
  try {
    await prisma.message.createMany({ data: [
      record('synthetic-last-older', phone, 1800000000),
      record('synthetic-last-expected', phone, 1800000001),
      record('synthetic-last-other-chat', '5511900000044@s.whatsapp.net', 1800000002),
      record('synthetic-last-foreign', phone, 1800000003, foreign.id),
    ] });
    const latest = await subject.getLastMessage(phone);
    assert.equal(latest.key.id, 'synthetic-last-expected');
    assert.equal(latest.instanceId, instance.id);
    const modifications = [];
    subject.client.chatModify = async (change, jid) => modifications.push({ change, jid });
    await subject.archiveChat({ chat: phone, archive: true });
    await subject.markChatUnread({ chat: phone });
    assert.equal(modifications.length, 2);
    assert.ok(modifications.every(({ change, jid }) => jid === phone && change.lastMessages[0].key.id === 'synthetic-last-expected'));
    await assert.rejects(subject.getLastMessage('5511900000045@s.whatsapp.net'), { status: 404, message: ['Messages not found'] });
    await assert.rejects(subject.getLastMessage("' OR 1=1 --"), { status: 404, message: ['Messages not found'] });
  } finally {
    await prisma.instance.delete({ where: { id: foreign.id } });
  }
});
