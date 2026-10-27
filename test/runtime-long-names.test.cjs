const assert = require('node:assert/strict');
const { test, before, after } = require('node:test');
const { PrismaClient } = require('@prisma/client');
if (new URL(process.env.DATABASE_CONNECTION_URI).pathname !== '/evolution_runtime_test') {
  throw new Error('Use the disposable evolution_runtime_test database.');
}
const prisma = new PrismaClient();
let instance;
const name = 'Synthetic contact name '.repeat(20);
before(async () => { instance = await prisma.instance.create({ data: { name: 'synthetic-long-names-' + Date.now() } }); });
after(async () => { await prisma.instance.delete({ where: { id: instance.id } }); await prisma.$disconnect(); });

test('preserves long WhatsApp chat names', async () => {
  const row = await prisma.chat.create({ data: { instanceId: instance.id, remoteJid: '5511900000000@s.whatsapp.net', name } });
  assert.equal(row.name, name);
});
test('preserves long WhatsApp contact names', async () => {
  const row = await prisma.contact.create({ data: { instanceId: instance.id, remoteJid: '5511900000000@s.whatsapp.net', pushName: name } });
  assert.equal(row.pushName, name);
});
test('preserves long sender names in history messages', async () => {
  const row = await prisma.message.create({ data: { instanceId: instance.id, key: { id: 'synthetic-long-name' },
    message: { conversation: 'Synthetic history' }, pushName: name, source: 'web', messageTimestamp: 1700000000, messageType: 'conversation' } });
  assert.equal(row.pushName, name);
});
