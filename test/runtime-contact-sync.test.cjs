const assert = require('node:assert/strict');
const { test, before, after, beforeEach } = require('node:test');
const { PrismaClient } = require('@prisma/client');
const EventEmitter2 = require('eventemitter2');
if (new URL(process.env.DATABASE_CONNECTION_URI).pathname !== '/evolution_runtime_test') {
  throw new Error('Use the disposable evolution_runtime_test database.');
}
const { BaileysStartupService } = require('../dist/api/integrations/channel/whatsapp/whatsapp.baileys.service');
const { configService } = require('../dist/config/env.config');
const prisma = new PrismaClient();
const cache = { get: async () => null, has: async () => false, set: async () => {}, delete: async () => {} };
let instance;
const services = [];
before(async () => {
  instance = await prisma.instance.create({ data: { name: 'synthetic-contact-sync-' + Date.now() } });
});
beforeEach(async () => { await prisma.contact.deleteMany({ where: { instanceId: instance.id } }); });
after(async () => {
  for (const service of services) service.messageProcessor.onDestroy();
  await prisma.instance.delete({ where: { id: instance.id } });
  await prisma.$disconnect();
});
function service(importContacts) {
  const result = new BaileysStartupService(configService, new EventEmitter2(), prisma, cache, cache, cache, null);
  Object.assign(result.instance, { id: instance.id, name: instance.name });
  Object.assign(result.localChatwoot, { enabled: true, importContacts, importMessages: true, daysLimitImportMessages: 90 });
  result.sendDataWebhook = async () => {};
  services.push(result);
  return result;
}
const contacts = () => Array.from({ length: 6 }, (_, i) => ({ id: `551190000000${i}@s.whatsapp.net`, name: `Synthetic ${i}` }));

test('stores metadata without fetching avatars or touching Chatwoot when contact import is disabled', async () => {
  const subject = service(false);
  let networkCalls = 0;
  subject.profilePicture = async () => { networkCalls++; return { profilePictureUrl: null }; };
  subject.chatwootService = {
    findContact: async () => { networkCalls++; return { id: 1 }; },
    updateContact: async () => { networkCalls++; },
  };
  await subject.contactHandle['contacts.upsert'](contacts());
  assert.equal(await prisma.contact.count({ where: { instanceId: instance.id } }), 6);
  assert.equal(networkCalls, 0);
});

test('finishes contact enrichment with at most one request in flight when import is enabled', async () => {
  const subject = service(true);
  let active = 0, maxActive = 0, updatesFinished = 0;
  const network = async () => {
    active++;
    maxActive = Math.max(active, maxActive);
    await new Promise((resolve) => setImmediate(resolve));
    active--;
  };
  subject.profilePicture = async () => { await network(); return { profilePictureUrl: null }; };
  subject.chatwootService = {
    addHistoryContacts: () => {},
    findContact: async () => { await network(); return { id: 1 }; },
    updateContact: async () => { await network(); updatesFinished++; },
  };
  await subject.contactHandle['contacts.upsert'](contacts());
  assert.equal(maxActive, 1);
  assert.equal(active, 0);
  assert.equal(updatesFinished, 6);
});

test('imports saved initial and FULL history batches after persistence', async () => {
  const subject = service(false);
  let imported = 0;
  let queued = 0;
  subject.chatwootService = {
    notifyHistoryImport: async () => {},
    addHistoryMessages: (_instance, messages) => { queued += messages.length; return 0; },
    importHistoryMessages: async () => {
      assert.equal(await prisma.message.count({ where: { instanceId: instance.id } }), queued);
      imported++;
      return queued;
    },
  };
  const batch = (id, progress, syncType = 0) => ({
    messages: [{ key: { id, fromMe: false, remoteJid: '5511900000000@s.whatsapp.net' },
      message: { conversation: 'Synthetic history' }, messageTimestamp: Math.floor(Date.now() / 1000) }],
    contacts: [], chats: [], isLatest: false, progress, syncType,
  });
  await subject.messageHandle['messaging-history.set'](batch('synthetic-partial', 10));
  assert.equal(imported, 1);
  await subject.messageHandle['messaging-history.set'](batch('synthetic-complete', 100, 2));
  assert.equal(queued, 2);
  assert.equal(imported, 2);
});


test('persists recipient names before queueing history for Chatwoot', async () => {
  const subject = service(false);
  let queued = false;
  subject.chatwootService = {
    notifyHistoryImport: async () => {},
    addHistoryMessages: async () => {
      const recipient = await prisma.contact.findFirst({ where: { instanceId: instance.id, remoteJid: '1234567890123456@lid' } });
      assert.equal(recipient.pushName, 'Synthetic recipient');
      queued = true;
      return 0;
    },
    importHistoryMessages: async () => 0,
  };
  await subject.messageHandle['messaging-history.set']({
    messages: [{ key: { id: 'synthetic-name-order', remoteJid: '1234567890123456@lid', fromMe: true },
      message: { conversation: 'Synthetic outgoing history' }, messageTimestamp: Math.floor(Date.now()/1000) }],
    contacts: [{ id: '1234567890123456@lid', name: 'Synthetic recipient' }], chats: [], syncType: 0,
  });
  assert.equal(queued, true);
});
