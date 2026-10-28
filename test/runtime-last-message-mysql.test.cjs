const assert = require('node:assert/strict');
const { test } = require('node:test');
const EventEmitter2 = require('eventemitter2');
if (new URL(process.env.DATABASE_CONNECTION_URI).pathname !== '/evolution_mysql_test' || process.env.DATABASE_PROVIDER !== 'mysql') {
  throw Error('Use the disposable evolution_mysql_test database and the MySQL Prisma client.');
}
const { PrismaClient } = require(process.env.MYSQL_PRISMA_CLIENT_MODULE || '@prisma/client');
const { BaileysStartupService } = require('../dist/api/integrations/channel/whatsapp/whatsapp.baileys.service');
const { configService } = require('../dist/config/env.config');

test('MySQL last-message queries preserve conversation and instance isolation for their consumers', async () => {
  const prisma = new PrismaClient();
  const cache = { get: async () => null, has: async () => false, set: async () => {}, delete: async () => {} };
  const subject = new BaileysStartupService(configService, new EventEmitter2(), prisma, cache, cache, cache, null);
  const created = [];
  try {
    for (const name of ['synthetic-mysql-a-', 'synthetic-mysql-b-']) {
      created.push(await prisma.instance.create({ data: { name: name + Date.now() } }));
    }
    Object.assign(subject.instance, { id: created[0].id, name: created[0].name });
    const phone = '5511900000042@s.whatsapp.net';
    const row = (id, timestamp, remoteJid = phone, instanceId = created[0].id) => ({
      instanceId, key: { id, remoteJid, fromMe: false }, message: { conversation: id },
      messageType: 'conversation', messageTimestamp: timestamp, source: 'web',
    });
    await prisma.message.createMany({ data: [row('older', 1800000000), row('expected', 1800000001),
      row('other-chat', 1800000002, '5511900000043@s.whatsapp.net'), row('foreign', 1800000003, phone, created[1].id)] });
    assert.equal((await subject.getLastMessage(phone)).key.id, 'expected');
    const changes = [];
    subject.client = { chatModify: async (change, jid) => changes.push({ change, jid }) };
    await subject.archiveChat({ chat: phone, archive: true });
    await subject.markChatUnread({ chat: phone });
    assert.equal(changes.length, 2);
    assert.ok(changes.every(({ change, jid }) => jid === phone && change.lastMessages[0].key.id === 'expected'));
    for (const missing of ['5511900000044@s.whatsapp.net', "' OR 1=1 --"]) {
      await assert.rejects(subject.getLastMessage(missing), { status: 404, message: ['Messages not found'] });
    }
  } finally {
    subject.messageProcessor.onDestroy();
    for (const instance of created) await prisma.instance.delete({ where: { id: instance.id } });
    await prisma.$disconnect();
  }
});
